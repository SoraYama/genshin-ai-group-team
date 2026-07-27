import { sanitizeTraceText } from '../../shared/agent-run-trace.js';
import { terminateSavedGate } from './saved-gate-runtime.js';

const REQUIRED_ADVISOR_STAGES = ['compose', 'critique', 'rotation', 'explain'] as const;
const STABLE_ADVISOR_STAGES = new Set([
  'knowledge',
  'research',
  'compose',
  'repair-1',
  'repair-2',
  'critique',
  'rotation',
  'explain'
]);
const ADVISOR_GATE_TIMEOUT_MS = 300_000;

export const ADVISOR_GATE_FAILURE_CODES = [
  'ADVISOR_TIMEOUT',
  'MISSING_SAVED_API_KEY',
  'SAVED_KEY_DECRYPT_FAILED',
  'SAFE_STORAGE_UNAVAILABLE',
  'ACTIVE_PROFILE_UNAVAILABLE',
  'ROSTER_INSUFFICIENT',
  'SCENARIO_UNAVAILABLE',
  'PROVIDER_ERROR',
  'ADVISOR_NOT_PLANNED',
  'ADVISOR_FELL_BACK',
  'TRACE_UNAVAILABLE',
  'TRACE_NOT_COMPLETED',
  'TRACE_SOURCE_MISMATCH',
  'AGENT_MODEL_MISSING',
  'REQUIRED_STAGE_MISSING',
  'REQUIRED_STAGE_NOT_COMPLETED',
  'STAGE_RAW_OUTPUT_MISSING',
  'STAGE_INPUT_USAGE_MISSING',
  'STAGE_OUTPUT_USAGE_MISSING',
  'TRACE_INPUT_USAGE_MISSING',
  'TRACE_OUTPUT_USAGE_MISSING',
  'TEAM_SIZE_INVALID',
  'CHARACTER_NOT_OWNED',
  'KNOWLEDGE_SUMMARY_MISMATCH',
  'ADVISOR_LATENCY_INVALID'
] as const;

export type AdvisorGateFailureCode = (typeof ADVISOR_GATE_FAILURE_CODES)[number];

type AdvisorSetupFailureCode = Extract<
  AdvisorGateFailureCode,
  | 'ADVISOR_TIMEOUT'
  | 'MISSING_SAVED_API_KEY'
  | 'SAVED_KEY_DECRYPT_FAILED'
  | 'SAFE_STORAGE_UNAVAILABLE'
  | 'ACTIVE_PROFILE_UNAVAILABLE'
  | 'ROSTER_INSUFFICIENT'
  | 'SCENARIO_UNAVAILABLE'
  | 'PROVIDER_ERROR'
>;

interface KnowledgeSummary {
  trusted: number;
  ephemeral: number;
  unknown: number;
  searched: boolean;
}

interface AdvisorGateResultEvidence {
  status: 'planned' | 'blocked';
  source: 'smart-service' | 'local-rules';
  knowledgeSummary: KnowledgeSummary;
  plan?: {
    scenarioId: string;
    dataVersion: string;
    firstHalfTeam: { characterIds: string[] };
    secondHalfTeam: { characterIds: string[] };
  };
}

interface AdvisorGateTraceEvidence {
  status: 'running' | 'completed' | 'failed';
  finalSource?: 'smart-service' | 'local-rules' | 'blocked';
  model: string;
  knowledge: KnowledgeSummary;
  usage: { inputTokens: number; outputTokens: number };
  failure?: AdvisorGateFailureEvidence;
  stages: Array<{
    stage: string;
    status: 'started' | 'completed' | 'failed' | 'skipped';
    rawOutput?: string;
    usage: { inputTokens: number; outputTokens: number };
    failure?: AdvisorGateFailureEvidence;
  }>;
}

interface AdvisorGateFailureEvidence {
  code: string;
  message?: string;
  retryable?: boolean;
  details?: Record<string, string>;
}

interface CharacterOwnershipEvidence {
  provenance: {
    ownership: {
      source: string;
    };
  };
}

export type AdvisorGateEvaluationInput =
  | {
      kind: 'unavailable';
      code: AdvisorSetupFailureCode;
    }
  | {
      kind: 'run';
      result: AdvisorGateResultEvidence;
      trace: AdvisorGateTraceEvidence | null;
      ownedCharacterIds: readonly string[];
      latencyMs: number;
    };

export type AdvisorGateOutput =
  | {
      gate: 'advisor-saved';
      status: 'passed';
      source: 'smart-service';
      model: string;
      scenarioId: string;
      dataVersion: string;
      stages: Array<(typeof REQUIRED_ADVISOR_STAGES)[number]>;
      usage: { inputTokens: number; outputTokens: number };
      ownedTeamMembers: 8;
      knowledgeSummary: KnowledgeSummary;
      latencyMs: number;
    }
  | {
      gate: 'advisor-saved';
      status: 'failed';
      code: AdvisorGateFailureCode;
      failedStage?: string;
      traceFailureCode?: string;
      sdkCode?: string;
      httpStatus?: number;
    };

export function evaluateAdvisorGate(input: AdvisorGateEvaluationInput): AdvisorGateOutput {
  if (input.kind === 'unavailable') return failed(input.code);
  if (input.result.status !== 'planned' || input.result.plan === undefined) {
    return failed('ADVISOR_NOT_PLANNED', input.trace);
  }
  if (input.result.source !== 'smart-service') return failed('ADVISOR_FELL_BACK', input.trace);
  if (input.trace === null) return failed('TRACE_UNAVAILABLE');
  if (input.trace.status !== 'completed') return failed('TRACE_NOT_COMPLETED', input.trace);
  if (input.trace.finalSource !== 'smart-service') {
    return failed('TRACE_SOURCE_MISMATCH', input.trace);
  }

  const model = sanitizeTraceText(input.trace.model, { maxBytes: 256 }).text.trim();
  if (model.length === 0) return failed('AGENT_MODEL_MISSING');

  for (const stageName of REQUIRED_ADVISOR_STAGES) {
    const stages = input.trace.stages.filter(({ stage: candidate }) => candidate === stageName);
    if (stages.length === 0) return failed('REQUIRED_STAGE_MISSING');
    const stagesToValidate =
      stageName === 'compose' && stages.some(({ status }) => status !== 'completed')
        ? latestCompletedComposerRepair(input.trace.stages)
        : stages;
    if (stagesToValidate.length === 0) {
      return failed('REQUIRED_STAGE_NOT_COMPLETED', input.trace);
    }
    for (const stage of stagesToValidate) {
      if (stage.status !== 'completed') {
        return failed('REQUIRED_STAGE_NOT_COMPLETED', input.trace);
      }
      if ((stage.rawOutput ?? '').trim().length === 0) {
        return failed('STAGE_RAW_OUTPUT_MISSING');
      }
      if (!positiveFinite(stage.usage.inputTokens)) {
        return failed('STAGE_INPUT_USAGE_MISSING');
      }
      if (!positiveFinite(stage.usage.outputTokens)) {
        return failed('STAGE_OUTPUT_USAGE_MISSING');
      }
    }
  }

  if (!positiveFinite(input.trace.usage.inputTokens)) {
    return failed('TRACE_INPUT_USAGE_MISSING');
  }
  if (!positiveFinite(input.trace.usage.outputTokens)) {
    return failed('TRACE_OUTPUT_USAGE_MISSING');
  }

  const firstHalf = input.result.plan.firstHalfTeam.characterIds;
  const secondHalf = input.result.plan.secondHalfTeam.characterIds;
  const members = [...firstHalf, ...secondHalf];
  if (
    firstHalf.length !== 4 ||
    secondHalf.length !== 4 ||
    members.length !== 8 ||
    new Set(members).size !== 8
  ) {
    return failed('TEAM_SIZE_INVALID');
  }
  const owned = new Set(input.ownedCharacterIds);
  if (members.some((characterId) => !owned.has(characterId))) {
    return failed('CHARACTER_NOT_OWNED');
  }
  if (!knowledgeMatches(input.result.knowledgeSummary, input.trace.knowledge)) {
    return failed('KNOWLEDGE_SUMMARY_MISMATCH');
  }
  if (!positiveFinite(input.latencyMs)) return failed('ADVISOR_LATENCY_INVALID');

  return {
    gate: 'advisor-saved',
    status: 'passed',
    source: 'smart-service',
    model,
    scenarioId: sanitizeTraceText(input.result.plan.scenarioId, { maxBytes: 256 }).text,
    dataVersion: sanitizeTraceText(input.result.plan.dataVersion, { maxBytes: 256 }).text,
    stages: [...REQUIRED_ADVISOR_STAGES],
    usage: {
      inputTokens: input.trace.usage.inputTokens,
      outputTokens: input.trace.usage.outputTokens
    },
    ownedTeamMembers: 8,
    knowledgeSummary: { ...input.result.knowledgeSummary },
    latencyMs: input.latencyMs
  };
}

function latestCompletedComposerRepair(
  stages: AdvisorGateTraceEvidence['stages']
): AdvisorGateTraceEvidence['stages'] {
  const repairs = stages.filter(
    ({ stage }) => stage === 'repair-1' || stage === 'repair-2'
  );
  const latest = repairs.at(-1);
  return latest?.status === 'completed' ? [latest] : [];
}

export function selectAuthoritativeOwnedCharacters<T extends CharacterOwnershipEvidence>(
  characters: readonly T[]
): T[] {
  return characters.filter(({ provenance }) => {
    const source = provenance.ownership.source;
    return source === 'miyoushe-index' || source === 'miyoushe-list';
  });
}

export function createNoopAdvisorGateHistory(): {
  appendAbyss: (_input: unknown) => undefined;
} {
  return { appendAbyss: () => undefined };
}

function failed(
  code: AdvisorGateFailureCode,
  trace?: AdvisorGateTraceEvidence | null
): AdvisorGateOutput {
  return {
    gate: 'advisor-saved',
    status: 'failed',
    code,
    ...traceFailureDiagnostics(trace)
  };
}

function traceFailureDiagnostics(
  trace: AdvisorGateTraceEvidence | null | undefined
): Pick<
  Extract<AdvisorGateOutput, { status: 'failed' }>,
  'failedStage' | 'traceFailureCode' | 'sdkCode' | 'httpStatus'
> {
  if (trace === null || trace === undefined) return {};
  const failedStage = [...trace.stages]
    .reverse()
    .find(({ status, stage }) => status === 'failed' && STABLE_ADVISOR_STAGES.has(stage));
  const rootFailure = trace.failure;
  const stageFailure = failedStage?.failure;
  const traceFailureCode =
    stableDiagnosticCode(rootFailure?.code) ?? stableDiagnosticCode(stageFailure?.code);
  const sdkCode =
    stableDiagnosticCode(rootFailure?.details?.['sdkCode']) ??
    stableDiagnosticCode(stageFailure?.details?.['sdkCode']);
  const httpStatus =
    stableDiagnosticHttpStatus(rootFailure?.details?.['httpStatus']) ??
    stableDiagnosticHttpStatus(stageFailure?.details?.['httpStatus']);
  return {
    ...(failedStage === undefined ? {} : { failedStage: failedStage.stage }),
    ...(traceFailureCode === undefined ? {} : { traceFailureCode }),
    ...(sdkCode === undefined ? {} : { sdkCode }),
    ...(httpStatus === undefined ? {} : { httpStatus })
  };
}

function stableDiagnosticCode(value: string | undefined): string | undefined {
  return value && /^[A-Z][A-Z0-9_]{0,79}$/u.test(value) ? value : undefined;
}

function stableDiagnosticHttpStatus(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-5]\d{2}$/u.test(value)) return undefined;
  const status = Number(value);
  return status >= 100 && status <= 599 ? status : undefined;
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export async function runAdvisorGateWithDeadline<T>(input: {
  run: () => Promise<T>;
  cancel: () => void;
  timeoutMs: number;
}): Promise<{ status: 'completed'; value: T } | { status: 'timed-out' }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const runOutcome = Promise.resolve()
    .then(input.run)
    .then(
      (value) => ({ status: 'completed' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error })
    );
  const timeoutOutcome = new Promise<{ status: 'timed-out' }>((resolve) => {
    timeout = setTimeout(() => {
      try {
        input.cancel();
      } catch {
        // The deadline result is authoritative even if cancellation bookkeeping fails.
      } finally {
        resolve({ status: 'timed-out' });
      }
    }, input.timeoutMs);
  });

  try {
    const outcome = await Promise.race([runOutcome, timeoutOutcome]);
    if (outcome.status === 'rejected') throw outcome.error;
    return outcome;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function knowledgeMatches(left: KnowledgeSummary, right: KnowledgeSummary): boolean {
  return (
    left.trusted === right.trusted &&
    left.ephemeral === right.ephemeral &&
    left.unknown === right.unknown &&
    left.searched === right.searched
  );
}

async function runAdvisorSavedGate(): Promise<AdvisorGateOutput> {
  const [
    { app, safeStorage },
    { ConfigService },
    { ProfileStore },
    { AgentSdkAdapter, supportsNativeWebSearch },
    { AgentRunTraceStore },
    { AbyssAdvisorService },
    { AbyssScenarioService },
    { CharacterKnowledgeStore },
    { KnowledgeBundleStore },
    { AdvisorKnowledgeService },
    { KnowledgeCoverageGate },
    { GuideResearchCache },
    { GuideResearchAgent },
    { ZhipuWebSearchClient, supportsZhipuWebSearch },
    { createProductionScenarioPublicationSource }
  ] = await Promise.all([
    import('electron'),
    import('../services/config-service.js'),
    import('../services/profile-store.js'),
    import('../services/agent-sdk-adapter.js'),
    import('../services/agent-run-trace-store.js'),
    import('../services/abyss-advisor-service.js'),
    import('../services/abyss-scenario-service.js'),
    import('../services/character-knowledge-store.js'),
    import('../services/knowledge-bundle-store.js'),
    import('../services/advisor-knowledge-service.js'),
    import('../services/knowledge-coverage-gate.js'),
    import('../services/guide-research-cache.js'),
    import('../services/guide-research-agent.js'),
    import('../services/zhipu-web-search-client.js'),
    import('../scenario-publication/production-composition.js')
  ]);
  const [path, { fileURLToPath }] = await Promise.all([import('node:path'), import('node:url')]);

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
    return evaluateAdvisorGate({
      kind: 'unavailable',
      code: savedConfigFailureCode(
        config.getPublicView().hasApiKey,
        safeStorage.isEncryptionAvailable()
      )
    });
  }

  const profileStore = new ProfileStore();
  const activeUid = profileStore.getActiveUid();
  const activeProfile = activeUid === undefined ? undefined : profileStore.get(activeUid);
  if (activeProfile === undefined || !/^\d{9}$/u.test(activeProfile.uid)) {
    return evaluateAdvisorGate({
      kind: 'unavailable',
      code: 'ACTIVE_PROFILE_UNAVAILABLE'
    });
  }
  const authoritativeCharacters = selectAuthoritativeOwnedCharacters(activeProfile.characters);
  if (authoritativeCharacters.length < 8) {
    return evaluateAdvisorGate({ kind: 'unavailable', code: 'ROSTER_INSUFFICIENT' });
  }
  const detailedCount = authoritativeCharacters.filter(
    ({ completeness }) => completeness === 'detailed'
  ).length;
  const profile = {
    ...activeProfile,
    characters: authoritativeCharacters,
    coverage: {
      ...activeProfile.coverage,
      ownedCount: authoritativeCharacters.length,
      detailedCount,
      buildCount: authoritativeCharacters.filter(({ completeness }) => completeness !== 'basic')
        .length,
      statsCount: authoritativeCharacters.filter(({ build }) => {
        const stats = build?.stats;
        return [stats?.hp, stats?.atk, stats?.def].every(
          (value) => typeof value === 'number' && Number.isFinite(value) && value > 0
        );
      }).length,
      enkaShowcaseCount: authoritativeCharacters.filter(
        ({ provenance }) => provenance.stats?.source === 'enka'
      ).length,
      missingDetailCount: authoritativeCharacters.length - detailedCount,
      partial:
        activeProfile.coverage.partial ||
        detailedCount !== authoritativeCharacters.length ||
        (activeProfile.coverage.expectedOwnedCount !== undefined &&
          activeProfile.coverage.expectedOwnedCount !== authoritativeCharacters.length)
    }
  };

  const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
  const userDataDirectory = app.getPath('userData');
  const knowledgeDirectory = app.isPackaged
    ? path.join(process.resourcesPath, 'knowledge')
    : path.resolve(runtimeDirectory, '../../resources/knowledge');
  const productionScenarios = await createProductionScenarioPublicationSource({
    userDataDir: userDataDirectory,
    packagedConfigPath: app.isPackaged
      ? path.join(process.resourcesPath, 'scenario-production.json')
      : path.resolve(runtimeDirectory, '../../resources/scenario-production.json'),
    env: process.env
  });
  const scenarioService = new AbyssScenarioService({
    enableDevelopmentScenarios: false,
    developmentFixturePath: path.join(
      userDataDirectory,
      '.advisor-saved-gate-development-disabled.json'
    ),
    ...(productionScenarios.status === 'configured'
      ? { productionSnapshot: () => productionScenarios.refresh('spiral-abyss') }
      : { productionUnavailableReason: productionScenarios.reason })
  });
  const scenarioView = await scenarioService.getView();
  if (
    scenarioView.status !== 'ready' ||
    scenarioView.trust !== 'production' ||
    !scenarioView.usableForRecommendation
  ) {
    return evaluateAdvisorGate({ kind: 'unavailable', code: 'SCENARIO_UNAVAILABLE' });
  }

  const [characterKnowledge, strategyKnowledge] = await Promise.all([
    CharacterKnowledgeStore.load(path.join(knowledgeDirectory, 'characters.v1.json')),
    KnowledgeBundleStore.load(knowledgeDirectory)
  ]);
  const advisorKnowledge = new AdvisorKnowledgeService(strategyKnowledge);
  const coverageGate = new KnowledgeCoverageGate(strategyKnowledge);
  const guideResearchCache = new GuideResearchCache({ userDataDirectory });
  const trace = new AgentRunTraceStore();
  const runner = new AgentSdkAdapter();
  const customHeaders = config.getCustomHeaders();
  const frozenScenarioService = { getView: async () => scenarioView };
  const advisor = new AbyssAdvisorService({
    runner,
    scenarioService: frozenScenarioService,
    profiles: { get: (uid) => (uid === profile.uid ? profile : undefined) },
    history: createNoopAdvisorGateHistory(),
    config,
    sdkEnvironment: { cwd: userDataDirectory, clientVersion: app.getVersion() },
    knowledge: characterKnowledge,
    strategyKnowledge,
    advisorKnowledge,
    coverageGate,
    research: {
      research: async (input, { signal }) => {
        const abortController = new AbortController();
        const cancel = () => abortController.abort();
        if (signal.aborted) cancel();
        else signal.addEventListener('abort', cancel, { once: true });
        try {
          return await new GuideResearchAgent({
            runner,
            cache: {
              get: (lookup) =>
                signal.aborted ? Promise.resolve(undefined) : guideResearchCache.get(lookup),
              put: (entry) =>
                signal.aborted
                  ? Promise.reject(new Error('Guide research was cancelled before cache write.'))
                  : guideResearchCache.put(entry)
            },
            sourceRegistry: strategyKnowledge,
            canonicalCharacterCatalog: strategyKnowledge.getCanonicalCharacterCatalog(),
            ...(supportsZhipuWebSearch(config.getBaseUrl())
              ? {
                  directSearch: new ZhipuWebSearchClient({
                    apiKey,
                    domain: 'www.hoyolab.com'
                  })
                }
              : {}),
            onUsageDelta: (usage) =>
              config.recordUsage(usage.inputTokens, usage.outputTokens, usage.estimatedCostUsd),
            sdkOptions: {
              apiKey,
              baseUrl: config.getBaseUrl(),
              model: config.getModel(),
              customHeaders,
              systemPrompt: '',
              cwd: userDataDirectory,
              clientVersion: app.getVersion(),
              abortController,
              maxTurns: 4,
              allowedBusinessTools: [],
              stderr: () => undefined
            }
          }).research(input);
        } finally {
          signal.removeEventListener('abort', cancel);
        }
      }
    },
    researchAvailable: () =>
      supportsNativeWebSearch(config.getBaseUrl()) ||
      supportsZhipuWebSearch(config.getBaseUrl()),
    trace,
    citationPolicy: {
      supportsCharacter: (citationId, characterId, archetypeId) =>
        strategyKnowledge.supportsCharacterCitation(citationId, characterId, archetypeId)
    }
  });

  const floor = Math.max(...scenarioView.scenario.floors.map(({ floor }) => floor));
  const correlationId = `advisor-saved-gate-${Date.now().toString(36)}`;
  const startedAt = Date.now();
  const deadline = await runAdvisorGateWithDeadline({
    run: () =>
      advisor.recommend({
        correlationId,
        uid: profile.uid,
        scenarioId: scenarioView.scenario.id,
        dataVersion: scenarioView.scenario.meta.dataVersion,
        locale: 'zh-CN',
        floor,
        preferences: {
          comfort: 'medium',
          survival: 'medium',
          lowInvestment: 'low',
          noBuildChange: true
        },
        lockedCharacterIds: [],
        excludedCharacterIds: []
      }),
    cancel: () => {
      advisor.cancel(correlationId);
    },
    timeoutMs: ADVISOR_GATE_TIMEOUT_MS
  });
  if (deadline.status === 'timed-out') {
    return evaluateAdvisorGate({ kind: 'unavailable', code: 'ADVISOR_TIMEOUT' });
  }

  const diagnosticTracePath = process.env['GTA_ADVISOR_GATE_TRACE_FILE']?.trim();
  if (diagnosticTracePath) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      diagnosticTracePath,
      `${JSON.stringify(trace.latest(), null, 2)}\n`,
      'utf8'
    );
  }

  return evaluateAdvisorGate({
    kind: 'run',
    result: deadline.value,
    trace: trace.latest(),
    ownedCharacterIds: profile.characters.map(({ id }) => String(id)),
    latencyMs: Date.now() - startedAt
  });
}

function savedConfigFailureCode(
  hasEncryptedKey: boolean,
  encryptionAvailable: boolean
): Extract<
  AdvisorSetupFailureCode,
  'MISSING_SAVED_API_KEY' | 'SAVED_KEY_DECRYPT_FAILED' | 'SAFE_STORAGE_UNAVAILABLE'
> {
  if (!hasEncryptedKey) return 'MISSING_SAVED_API_KEY';
  return encryptionAvailable ? 'SAVED_KEY_DECRYPT_FAILED' : 'SAFE_STORAGE_UNAVAILABLE';
}

async function main(): Promise<void> {
  let output: AdvisorGateOutput;
  try {
    output = await runAdvisorSavedGate();
  } catch {
    output = failed('PROVIDER_ERROR');
  }
  const [{ app }, { writeFileSync }] = await Promise.all([import('electron'), import('node:fs')]);
  terminateSavedGate(output, {
    write: (line) => writeFileSync(process.stdout.fd, line, 'utf8'),
    exit: (code) => app.exit(code)
  });
}

if (process.versions.electron !== undefined) {
  void main();
}
