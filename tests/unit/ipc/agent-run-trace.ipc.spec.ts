import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event: unknown, payload: unknown) => Promise<unknown> | unknown
  >();
  const exposed = new Map<string, unknown>();
  return {
    handlers,
    exposed,
    contextBridge: {
      exposeInMainWorld: vi.fn((name: string, api: unknown) => exposed.set(name, api))
    },
    ipcMain: {
      handle: vi.fn(
        (
          channel: string,
          handler: (event: unknown, payload: unknown) => Promise<unknown> | unknown
        ) => handlers.set(channel, handler)
      )
    },
    ipcRenderer: {
      invoke: vi.fn(async (channel: string, payload: unknown) => {
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
        return handler(undefined, payload);
      }),
      on: vi.fn(),
      removeListener: vi.fn()
    }
  };
});

vi.mock('electron', () => ({
  contextBridge: electron.contextBridge,
  ipcMain: electron.ipcMain,
  ipcRenderer: electron.ipcRenderer
}));

import { registerAbyssAdvisorIpc } from '../../../src/main/ipc/abyss-advisor.ipc.js';
import { AgentRunTraceStore } from '../../../src/main/services/agent-run-trace-store.js';
import {
  ALL_IPC_CHANNELS,
  type RendererApi
} from '../../../src/shared/ipc-contract.js';
import '../../../src/main/preload.js';

type TraceReader = { latest: () => ReturnType<AgentRunTraceStore['latest']> };
type ExpectedTraceApi = RendererApi['abyssAdvisor'] & {
  getLatestTrace?: () => Promise<ReturnType<AgentRunTraceStore['latest']>>;
  getTraceHistory?: unknown;
  onTrace?: unknown;
};

let traceStore = new AgentRunTraceStore();
let latest: TraceReader['latest'] = () => traceStore.latest();
const injectedTraceReader: TraceReader = { latest: () => latest() };

function traceApi(): ExpectedTraceApi {
  const api = electron.exposed.get('api') as RendererApi | undefined;
  if (!api) throw new Error('Expected preload API');
  return api.abyssAdvisor;
}

function getLatestTrace(): NonNullable<ExpectedTraceApi['getLatestTrace']> {
  const method = traceApi().getLatestTrace;
  if (!method) throw new Error('Expected getLatestTrace preload method');
  return method;
}

beforeAll(() => {
  registerAbyssAdvisorIpc({
    scenario: { getView: vi.fn() },
    advisor: { recommend: vi.fn(), cancel: vi.fn() },
    traceStore: injectedTraceReader,
    getMainWindow: () => undefined
  });
});

beforeEach(() => {
  traceStore = new AgentRunTraceStore();
  latest = () => traceStore.latest();
  electron.ipcRenderer.invoke.mockClear();
});

describe('latest agent run trace IPC', () => {
  it('exposes only the latest-trace query through the fixed whitelist and preload surface', () => {
    expect(ALL_IPC_CHANNELS).toContain('advisor-v2:abyss-latest-trace');
    expect(ALL_IPC_CHANNELS).not.toContain('advisor-v2:abyss-trace-history');
    expect(ALL_IPC_CHANNELS).not.toContain('advisor-v2:abyss-trace-event');
    expect(traceApi().getLatestTrace).toBeTypeOf('function');
    expect(traceApi().getTraceHistory).toBeUndefined();
    expect(traceApi().onTrace).toBeUndefined();
  });

  it('returns null through the fixed invoke channel when no run exists', async () => {
    await expect(getLatestTrace()()).resolves.toBeNull();
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      'advisor-v2:abyss-latest-trace',
      undefined
    );
  });

  it('returns the sanitized latest trace without leaking mutable references across reads', async () => {
    const lease = traceStore.start({
      correlationId: 'latest-run',
      model: 'test-model',
      knowledge: { trusted: 1, ephemeral: 0, unknown: 0, searched: false },
      sensitiveValues: ['secret-api-key'],
      startedAt: '2026-07-25T00:00:00.000Z'
    });
    traceStore.startStage(lease, {
      stage: 'compose',
      inputSummary: 'safe prompt with secret-api-key'
    });
    traceStore.completeStage(lease, {
      stage: 'compose',
      rawOutput: 'safe model output with secret-api-key',
      tools: [],
      citationIds: [],
      usage: { inputTokens: 2, outputTokens: 3 },
      durationMs: 4
    });
    traceStore.finish(lease, {
      finalSource: 'smart-service',
      finishedAt: '2026-07-25T00:00:01.000Z'
    });

    const first = await getLatestTrace()();
    expect(first).toMatchObject({
      correlationId: 'latest-run',
      status: 'completed',
      stages: [{ stage: 'compose', status: 'completed' }]
    });
    expect(JSON.stringify(first)).not.toContain('secret-api-key');
    if (!first) throw new Error('Expected a trace');
    first.knowledge.trusted = 999;
    first.stages[0]!.inputSummary = 'mutated outside the store';

    const second = await getLatestTrace()();
    expect(second).not.toBe(first);
    expect(second).toMatchObject({
      knowledge: { trusted: 1 },
      stages: [{ inputSummary: expect.not.stringContaining('mutated outside the store') }]
    });
  });

  it('preserves the stable internal-error contract without exposing store failures', async () => {
    latest = () => {
      throw new Error('trace file /private/raw-traces.json contained secret-api-key');
    };

    await expect(getLatestTrace()()).rejects.toMatchObject({
      code: 'IPC_INTERNAL',
      message: 'Internal request error'
    });
    await expect(getLatestTrace()()).rejects.not.toThrow(/private|secret-api-key/);
  });

  it('wires the same in-memory store into the Abyss advisor and its IPC reader', () => {
    const mainSource = readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    const traceStoreCreations = mainSource.match(/new AgentRunTraceStore\(/g) ?? [];
    const advisorWiring = mainSource.slice(
      mainSource.indexOf('const abyssAdvisor = new AbyssAdvisorService({'),
      mainSource.indexOf('registerStygianAdvisorIpc({')
    );

    expect(traceStoreCreations).toHaveLength(1);
    expect(advisorWiring).toContain('trace: abyssTrace');
    expect(advisorWiring).toContain('traceStore: abyssTrace');
  });
});
