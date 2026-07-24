import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  query,
  type HookCallback,
  type Options as SdkOptions,
  type Query
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { validateCustomHeaders } from '../../shared/custom-headers.js';

const DENIED_NATIVE_TOOLS = [
  'Agent',
  'Task',
  'Bash',
  'Edit',
  'Write',
  'Read',
  'Glob',
  'Grep',
  'NotebookEdit',
  'WebFetch',
  'WebSearch'
];

function businessToolGate(allowedTools: ReadonlySet<string>): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse' || allowedTools.has(input.tool_name)) {
      return { continue: true };
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Tool is not registered for this agent: ${input.tool_name}`
      }
    };
  };
}

const nativeToolPolicySchema = z
  .object({
    purpose: z.literal('research'),
    allowed: z.tuple([z.literal('WebSearch')]),
    maxSearches: z.literal(3)
  })
  .strict();
const researchSearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(300)
  })
  .strict()
  .superRefine(({ query }, context) => {
    const normalized = query.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '');
    if (
      /(?:\buid\b|\b\d{9,}\b|昵称|cookie|authorization|api[-_ ]?key|bearer\s|ltoken|ltuid|ltmid|sk-[a-z0-9_-]+|crit(?:ical)?[-_ ]?(?:rate|dmg)|暴击(?:率|伤害)?|攻击力|生命值|防御力)/iu.test(
        normalized
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['query'],
        message: 'Research query contains account, credential, or panel material'
      });
    }
  });

export interface ResearchNativeToolPolicy {
  purpose: 'research';
  allowed: ['WebSearch'];
  maxSearches: 3;
}

export function createResearchToolGate(input: { maxSearches: 3 }): HookCallback {
  let searches = 0;
  return async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return { continue: true };
    if (hookInput.tool_name !== 'WebSearch') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'RESEARCH_TOOL_NOT_ALLOWED'
        }
      };
    }
    if (!researchSearchInputSchema.safeParse(hookInput.tool_input).success) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'SEARCH_QUERY_REJECTED'
        }
      };
    }
    searches += 1;
    if (searches > input.maxSearches) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'SEARCH_BUDGET_EXCEEDED'
        }
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow'
      }
    };
  };
}

export interface AgentSdkRunOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  cwd: string;
  abortController: AbortController;
  maxTurns?: number;
  stderr?: (data: string) => void;
  pathToClaudeCodeExecutable?: string;
  customHeaders?: Record<string, string>;
  clientVersion?: string;
  mcpServers?: SdkOptions['mcpServers'];
  allowedBusinessTools?: string[];
  nativeToolPolicy?: ResearchNativeToolPolicy;
}

function serializeCustomHeaders(headers: Record<string, string> | undefined): string | undefined {
  const validated = validateCustomHeaders(headers);
  if (!validated) return undefined;
  const lines = Object.entries(validated).map(([name, value]) => `${name}: ${value}`);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

export function resolvePackagedClaudeExecutable(
  resourcesPath: string | undefined = process.resourcesPath,
  platform = process.platform,
  arch = process.arch
): string | undefined {
  if (!resourcesPath) return undefined;
  const executableName = platform === 'win32' ? 'claude.exe' : 'claude';
  const candidate = path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    `claude-agent-sdk-${platform}-${arch}`,
    executableName
  );
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Builds the production-safe SDK boundary used by every isolated orchestration stage.
 * No built-in tool is exposed. Future business MCP tools must be added to an
 * explicit allow-list here; user/project Claude settings are never inherited.
 */
export function buildAgentSdkOptions(input: AgentSdkRunOptions): SdkOptions {
  const bundledExecutable = input.pathToClaudeCodeExecutable ?? resolvePackagedClaudeExecutable();
  const customHeaders = serializeCustomHeaders(input.customHeaders);
  const allowedBusinessTools = input.allowedBusinessTools ?? [];
  const nativeToolPolicy =
    input.nativeToolPolicy === undefined
      ? undefined
      : nativeToolPolicySchema.parse(input.nativeToolPolicy);
  if (
    nativeToolPolicy !== undefined &&
    (allowedBusinessTools.length > 0 || input.mcpServers !== undefined)
  ) {
    throw new Error('Native research tools cannot be combined with business MCP tools');
  }
  const isResearch = nativeToolPolicy !== undefined;
  const allowedTools = isResearch ? ['WebSearch'] : allowedBusinessTools;
  const disallowedTools = isResearch
    ? DENIED_NATIVE_TOOLS.filter((tool) => tool !== 'WebSearch')
    : [...DENIED_NATIVE_TOOLS];
  const toolGate = isResearch
    ? createResearchToolGate({ maxSearches: nativeToolPolicy.maxSearches })
    : businessToolGate(new Set(allowedBusinessTools));
  return {
    systemPrompt: input.systemPrompt,
    env: {
      ANTHROPIC_AUTH_TOKEN: input.apiKey,
      ANTHROPIC_BASE_URL: input.baseUrl,
      ANTHROPIC_MODEL: input.model,
      CLAUDE_AGENT_SDK_CLIENT_APP: `genshin-team-advisor/${input.clientVersion ?? 'development'}`,
      CLAUDE_CONFIG_DIR: path.join(input.cwd, 'agent-runtime'),
      ...(customHeaders ? { ANTHROPIC_CUSTOM_HEADERS: customHeaders } : {})
    },
    model: input.model,
    tools: isResearch ? ['WebSearch'] : [],
    allowedTools,
    disallowedTools,
    permissionMode: 'dontAsk',
    hooks: {
      PreToolUse: [{ hooks: [toolGate] }]
    },
    maxTurns: input.maxTurns ?? 1,
    abortController: input.abortController,
    cwd: input.cwd,
    persistSession: false,
    settingSources: [],
    strictMcpConfig: true,
    ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
    stderr: input.stderr,
    ...(bundledExecutable ? { pathToClaudeCodeExecutable: bundledExecutable } : {})
  };
}

export class AgentSdkAdapter {
  run(prompt: string, options: AgentSdkRunOptions): Query {
    return query({ prompt, options: buildAgentSdkOptions(options) });
  }
}
