import { sanitizeTraceText } from '../../shared/agent-run-trace.js';

const AGENT_GATE_RAW_TEXT_MAX_BYTES = 4_096;
const AGENT_GATE_MODEL_MAX_BYTES = 256;
const AGENT_GATE_TIMEOUT_MS = 60_000;

export const AGENT_GATE_FAILURE_CODES = [
  'MISSING_SAVED_API_KEY',
  'SAVED_KEY_DECRYPT_FAILED',
  'SAFE_STORAGE_UNAVAILABLE',
  'AGENT_TIMEOUT',
  'PROVIDER_ERROR',
  'EMPTY_AGENT_RESULT',
  'AGENT_INPUT_USAGE_MISSING',
  'AGENT_OUTPUT_USAGE_MISSING',
  'AGENT_MODEL_MISSING',
  'AGENT_LATENCY_INVALID'
] as const;

export type AgentGateFailureCode = (typeof AGENT_GATE_FAILURE_CODES)[number];

type SavedConfigFailureCode = Extract<
  AgentGateFailureCode,
  'MISSING_SAVED_API_KEY' | 'SAVED_KEY_DECRYPT_FAILED' | 'SAFE_STORAGE_UNAVAILABLE'
>;

interface AgentGateUsageInput {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export type AgentGateEvaluationInput =
  | {
      kind: 'unavailable';
      code: SavedConfigFailureCode;
    }
  | {
      kind: 'provider-error';
      timedOut: boolean;
      sdkCode?: string;
      httpStatus?: number;
    }
  | {
      kind: 'turn';
      model: string;
      rawText: string;
      usage: AgentGateUsageInput;
      latencyMs: number;
      sensitiveValues: readonly string[];
    };

export type AgentGateOutput =
  | {
      gate: 'agent-saved';
      status: 'passed';
      model: string;
      rawText: string;
      usage: { inputTokens: number; outputTokens: number };
      latencyMs: number;
    }
  | {
      gate: 'agent-saved';
      status: 'failed';
      code: AgentGateFailureCode;
      sdkCode?: string;
      httpStatus?: number;
    };

export function evaluateAgentGate(input: AgentGateEvaluationInput): AgentGateOutput {
  if (input.kind === 'unavailable') return failed(input.code);
  if (input.kind === 'provider-error') {
    if (input.timedOut) return failed('AGENT_TIMEOUT');
    const sdkCode = stableSdkCode(input.sdkCode);
    const httpStatus = stableHttpStatus(input.httpStatus);
    return {
      ...failed('PROVIDER_ERROR'),
      ...(sdkCode === undefined ? {} : { sdkCode }),
      ...(httpStatus === undefined ? {} : { httpStatus })
    };
  }

  const rawText = sanitizeTraceText(input.rawText, {
    maxBytes: AGENT_GATE_RAW_TEXT_MAX_BYTES,
    customHeaderValues: input.sensitiveValues
  }).text.trim();
  if (rawText.length === 0) return failed('EMPTY_AGENT_RESULT');
  if (!positiveFinite(input.usage.inputTokens)) {
    return failed('AGENT_INPUT_USAGE_MISSING');
  }
  if (!positiveFinite(input.usage.outputTokens)) {
    return failed('AGENT_OUTPUT_USAGE_MISSING');
  }
  const model = sanitizeTraceText(input.model, {
    maxBytes: AGENT_GATE_MODEL_MAX_BYTES,
    customHeaderValues: input.sensitiveValues
  }).text.trim();
  if (model.length === 0) return failed('AGENT_MODEL_MISSING');
  if (!nonnegativeFinite(input.latencyMs)) return failed('AGENT_LATENCY_INVALID');

  return {
    gate: 'agent-saved',
    status: 'passed',
    model,
    rawText,
    usage: {
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens
    },
    latencyMs: input.latencyMs
  };
}

export function gateExitCode(output: { status: 'passed' | 'failed' }): 0 | 1 {
  return output.status === 'passed' ? 0 : 1;
}

function failed(code: AgentGateFailureCode): AgentGateOutput {
  return { gate: 'agent-saved', status: 'failed', code };
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function nonnegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function stableSdkCode(value: string | undefined): string | undefined {
  return value && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value) ? value : undefined;
}

function stableHttpStatus(value: number | undefined): number | undefined {
  return Number.isInteger(value) && value !== undefined && value >= 100 && value <= 599
    ? value
    : undefined;
}

async function runAgentSavedGate(): Promise<AgentGateOutput> {
  const [{ app, safeStorage }, { ConfigService }, { AgentSdkAdapter }, agentTurnAudit] =
    await Promise.all([
      import('electron'),
      import('../services/config-service.js'),
      import('../services/agent-sdk-adapter.js'),
      import('../services/agent-turn-audit.js')
    ]);
  const path = await import('node:path');

  app.setName(process.env.GTA_SAFE_STORAGE_APP_NAME ?? 'genshin-team-advisor');
  const isolatedUserDataDirectory = process.env.GTA_E2E_USER_DATA_DIR?.trim();
  if (isolatedUserDataDirectory) {
    app.setPath('userData', isolatedUserDataDirectory);
  } else if (!app.isPackaged) {
    app.setPath('userData', path.join(app.getPath('appData'), 'genshin-team-advisor'));
  }
  await app.whenReady();

  const config = new ConfigService();
  const apiKey = config.getApiKey();
  if (apiKey === undefined) {
    return evaluateAgentGate({
      kind: 'unavailable',
      code: savedConfigFailureCode(
        config.getPublicView().hasApiKey,
        safeStorage.isEncryptionAvailable()
      )
    });
  }

  const customHeaders = config.getCustomHeaders();
  const abortController = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, AGENT_GATE_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const turn = await agentTurnAudit.runAuditedAgentTurn({
      runner: new AgentSdkAdapter(),
      prompt: 'Reply with exactly this short text: agent gate ok',
      systemPrompt:
        'This is a saved-provider SDK verification turn. Do not use tools. Return only the requested short text.',
      sdkOptions: {
        apiKey,
        baseUrl: config.getBaseUrl(),
        model: config.getModel(),
        customHeaders,
        systemPrompt:
          'This is a saved-provider SDK verification turn. Do not use tools. Return only the requested short text.',
        cwd: app.getPath('userData'),
        clientVersion: app.getVersion(),
        abortController,
        maxTurns: 1,
        allowedBusinessTools: [],
        stderr: () => undefined
      }
    });
    config.recordUsage(
      turn.usage.inputTokens,
      turn.usage.outputTokens,
      turn.usage.estimatedCostUsd
    );
    return evaluateAgentGate({
      kind: 'turn',
      model: config.getModel(),
      rawText: turn.finalRawText,
      usage: turn.usage,
      latencyMs: Date.now() - startedAt,
      sensitiveValues: [apiKey, ...Object.values(customHeaders)]
    });
  } catch (error) {
    const details = agentTurnAudit.safeAgentTurnFailureDetails(error);
    return evaluateAgentGate({
      kind: 'provider-error',
      timedOut,
      sdkCode: details.sdkCode,
      httpStatus: details.httpStatus
    });
  } finally {
    clearTimeout(timeout);
  }
}

function savedConfigFailureCode(
  hasEncryptedKey: boolean,
  encryptionAvailable: boolean
): SavedConfigFailureCode {
  if (!hasEncryptedKey) return 'MISSING_SAVED_API_KEY';
  return encryptionAvailable ? 'SAVED_KEY_DECRYPT_FAILED' : 'SAFE_STORAGE_UNAVAILABLE';
}

async function main(): Promise<void> {
  let output: AgentGateOutput;
  try {
    output = await runAgentSavedGate();
  } catch {
    output = failed('PROVIDER_ERROR');
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = gateExitCode(output);
  const { app } = await import('electron');
  app.quit();
}

if (process.versions.electron !== undefined) {
  void main();
}
