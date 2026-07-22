import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  query,
  type HookCallback,
  type Options as SdkOptions,
  type Query
} from '@anthropic-ai/claude-agent-sdk';

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
}

function serializeCustomHeaders(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  const lines = Object.entries(headers)
    .filter(([name, value]) => /^[A-Za-z0-9-]+$/.test(name) && !/[\r\n]/.test(value))
    .map(([name, value]) => `${name}: ${value}`);
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
    tools: [],
    allowedTools: allowedBusinessTools,
    disallowedTools: DENIED_NATIVE_TOOLS,
    permissionMode: 'dontAsk',
    hooks: {
      PreToolUse: [{ hooks: [businessToolGate(new Set(allowedBusinessTools))] }]
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
