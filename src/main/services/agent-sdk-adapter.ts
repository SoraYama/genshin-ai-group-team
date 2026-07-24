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
import { privacySafeResearchText } from './research-privacy.js';

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
const researchQueryTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .superRefine((query, context) => {
    if (privacySafeResearchText(query) === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'Research query contains account, credential, or panel material'
      });
    }
  });
const researchSearchInputSchema = z
  .object({
    query: researchQueryTextSchema
  })
  .strict();
const researchAllowedQueriesSchema = z
  .array(researchQueryTextSchema)
  .min(1)
  .max(3)
  .superRefine((queries, context) => {
    const normalized = queries.map(privacySafeResearchText);
    if (new Set(normalized).size !== normalized.length) {
      context.addIssue({
        code: 'custom',
        message: 'Research query allowlist entries must be unique'
      });
    }
  })
  .transform((queries) => queries.map((query) => privacySafeResearchText(query)!));

export interface ResearchNativeToolPolicy {
  purpose: 'research';
  allowed: ['WebSearch'];
  maxSearches: 3;
}

type ResearchGateDecision = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
};

export function createResearchToolGate(input: {
  maxSearches: 3;
  allowedQueries: readonly string[];
}): HookCallback {
  const allowedQueries = new Set(researchAllowedQueriesSchema.parse(input.allowedQueries));
  const decisionsByToolUseId = new Map<string, ResearchGateDecision>();
  let searchAttempts = 0;
  return async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return { continue: true };
    if (hookInput.tool_name !== 'WebSearch') {
      return denyResearchTool('RESEARCH_TOOL_NOT_ALLOWED');
    }
    const toolUseId = validToolUseId(hookInput.tool_use_id);
    if (toolUseId !== undefined) {
      const replay = decisionsByToolUseId.get(toolUseId);
      if (replay !== undefined) return replay;
    }

    searchAttempts += 1;
    if (searchAttempts > input.maxSearches) {
      const decision = denyResearchTool('SEARCH_BUDGET_EXCEEDED');
      if (toolUseId !== undefined) decisionsByToolUseId.set(toolUseId, decision);
      return decision;
    }
    const parsedInput = researchSearchInputSchema.safeParse(hookInput.tool_input);
    const query = parsedInput.success ? privacySafeResearchText(parsedInput.data.query) : undefined;
    if (toolUseId === undefined || query === undefined || !allowedQueries.has(query)) {
      const decision = denyResearchTool('SEARCH_QUERY_REJECTED');
      if (toolUseId !== undefined) decisionsByToolUseId.set(toolUseId, decision);
      return decision;
    }
    const decision: ResearchGateDecision = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow'
      }
    };
    decisionsByToolUseId.set(toolUseId, decision);
    return decision;
  };
}

function denyResearchTool(reason: string): ResearchGateDecision {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  };
}

function validToolUseId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
    ? value
    : undefined;
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
  researchAllowedQueries?: readonly string[];
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
  const researchAllowedQueries =
    nativeToolPolicy === undefined
      ? undefined
      : researchAllowedQueriesSchema.parse(input.researchAllowedQueries);
  if (nativeToolPolicy === undefined && input.researchAllowedQueries !== undefined) {
    throw new Error('Research query allowlists require the native research policy');
  }
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
    ? createResearchToolGate({
        maxSearches: nativeToolPolicy.maxSearches,
        allowedQueries: researchAllowedQueries!
      })
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
