import { createHash } from 'node:crypto';
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

interface BoundResearchGateDecision {
  fingerprint: string;
  decision: ResearchGateDecision;
}

const INVALID_RESEARCH_TOOL_FINGERPRINT = 'invalid-research-tool-payload';

export function createResearchToolGate(input: {
  maxSearches: 3;
  allowedQueries: readonly string[];
}): HookCallback {
  const allowedQueries = new Set(researchAllowedQueriesSchema.parse(input.allowedQueries));
  const decisionsByToolUseId = new Map<string, BoundResearchGateDecision>();
  let searchAttempts = 0;
  return async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return { continue: true };
    const toolUseId = validToolUseId(hookInput.tool_use_id);
    const toolName = normalizedToolName(hookInput.tool_name);
    const exactFingerprint = researchToolPayloadFingerprint(toolName, hookInput.tool_input);
    const fingerprint = exactFingerprint ?? INVALID_RESEARCH_TOOL_FINGERPRINT;
    if (toolUseId !== undefined) {
      const replay = decisionsByToolUseId.get(toolUseId);
      if (replay !== undefined) {
        if (
          exactFingerprint !== undefined &&
          replay.fingerprint !== INVALID_RESEARCH_TOOL_FINGERPRINT &&
          replay.fingerprint === exactFingerprint
        ) {
          return replay.decision;
        }
        searchAttempts += 1;
        return searchAttempts > input.maxSearches
          ? denyResearchTool('SEARCH_BUDGET_EXCEEDED')
          : denyResearchTool('SEARCH_TOOL_REPLAY_MISMATCH');
      }
    }
    if (toolName !== 'WebSearch') {
      const decision = denyResearchTool('RESEARCH_TOOL_NOT_ALLOWED');
      bindResearchDecision(decisionsByToolUseId, toolUseId, fingerprint, decision);
      return decision;
    }

    searchAttempts += 1;
    if (searchAttempts > input.maxSearches) {
      const decision = denyResearchTool('SEARCH_BUDGET_EXCEEDED');
      bindResearchDecision(decisionsByToolUseId, toolUseId, fingerprint, decision);
      return decision;
    }
    const parsedInput = researchSearchInputSchema.safeParse(hookInput.tool_input);
    const query = parsedInput.success ? privacySafeResearchText(parsedInput.data.query) : undefined;
    if (toolUseId === undefined || query === undefined || !allowedQueries.has(query)) {
      const decision = denyResearchTool('SEARCH_QUERY_REJECTED');
      bindResearchDecision(decisionsByToolUseId, toolUseId, fingerprint, decision);
      return decision;
    }
    const decision: ResearchGateDecision = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow'
      }
    };
    bindResearchDecision(decisionsByToolUseId, toolUseId, fingerprint, decision);
    return decision;
  };
}

function bindResearchDecision(
  decisions: Map<string, BoundResearchGateDecision>,
  toolUseId: string | undefined,
  fingerprint: string,
  decision: ResearchGateDecision
): void {
  if (toolUseId !== undefined) decisions.set(toolUseId, { fingerprint, decision });
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

function normalizedToolName(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 80 ? value : undefined;
}

function researchToolPayloadFingerprint(
  toolName: string | undefined,
  toolInput: unknown
): string | undefined {
  if (toolName === undefined) return undefined;
  const budget = { nodes: 0 };
  const canonicalInput = canonicalToolPayload(toolInput, 0, budget);
  if (canonicalInput === undefined || canonicalInput.length > 8_192) return undefined;
  return createHash('sha256')
    .update(`${JSON.stringify(toolName)}:${canonicalInput}`)
    .digest('hex');
}

function canonicalToolPayload(
  value: unknown,
  depth: number,
  budget: { nodes: number }
): string | undefined {
  budget.nodes += 1;
  if (depth > 8 || budget.nodes > 256) return undefined;
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (typeof value === 'string') {
    return value.length <= 2_048 ? JSON.stringify(value) : undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) return undefined;
    const items = value.map((item) => canonicalToolPayload(item, depth + 1, budget));
    return items.some((item) => item === undefined) ? undefined : `[${items.join(',')}]`;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 64) return undefined;
  if (entries.some(([key]) => key.length === 0 || key.length > 128)) return undefined;
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const members = entries.map(([key, child]) => {
    const canonicalChild = canonicalToolPayload(child, depth + 1, budget);
    return canonicalChild === undefined ? undefined : `${JSON.stringify(key)}:${canonicalChild}`;
  });
  return members.some((member) => member === undefined) ? undefined : `{${members.join(',')}}`;
}

export interface AgentSdkRunOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  cwd: string;
  abortController: AbortController;
  maxTurns?: number;
  effort?: SdkOptions['effort'];
  thinking?: SdkOptions['thinking'];
  maxThinkingTokens?: number;
  outputFormat?: SdkOptions['outputFormat'];
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

function providerCredentialEnv(
  baseUrl: string,
  apiKey: string
): { ANTHROPIC_API_KEY: string } | { ANTHROPIC_AUTH_TOKEN: string } {
  try {
    if (new URL(baseUrl).hostname.toLowerCase() === 'api.anthropic.com') {
      return { ANTHROPIC_API_KEY: apiKey };
    }
  } catch {
    // The provider request will report the invalid URL; keep compatibility auth semantics here.
  }
  return { ANTHROPIC_AUTH_TOKEN: apiKey };
}

function providerHostname(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function supportsNativeWebSearch(baseUrl: string): boolean {
  return providerHostname(baseUrl) === 'api.anthropic.com';
}

function providerThinkingControls(
  baseUrl: string,
  model: string
): Pick<SdkOptions, 'thinking' | 'maxThinkingTokens'> {
  if (
    providerHostname(baseUrl) === 'open.bigmodel.cn' &&
    /^glm(?:-|$)/iu.test(model.trim())
  ) {
    return {
      thinking: { type: 'disabled' },
      maxThinkingTokens: 0
    };
  }
  return {};
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
  const providerThinking = providerThinkingControls(input.baseUrl, input.model);
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
      ...providerCredentialEnv(input.baseUrl, input.apiKey),
      ANTHROPIC_BASE_URL: input.baseUrl,
      ANTHROPIC_MODEL: input.model,
      CLAUDE_AGENT_SDK_CLIENT_APP: `genshin-team-advisor/${input.clientVersion ?? 'development'}`,
      CLAUDE_CONFIG_DIR: path.join(input.cwd, 'agent-runtime'),
      ...(customHeaders ? { ANTHROPIC_CUSTOM_HEADERS: customHeaders } : {})
    },
    model: input.model,
    effort: input.effort ?? 'medium',
    ...(input.thinking === undefined
      ? providerThinking.thinking === undefined
        ? {}
        : { thinking: providerThinking.thinking }
      : { thinking: input.thinking }),
    ...(input.maxThinkingTokens === undefined
      ? providerThinking.maxThinkingTokens === undefined
        ? {}
        : { maxThinkingTokens: providerThinking.maxThinkingTokens }
      : { maxThinkingTokens: input.maxThinkingTokens }),
    ...(input.outputFormat === undefined ? {} : { outputFormat: input.outputFormat }),
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
