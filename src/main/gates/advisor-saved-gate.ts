import { sanitizeTraceText } from '../../shared/agent-run-trace.js';

const REQUIRED_ADVISOR_STAGES = ['compose', 'critique', 'rotation', 'explain'] as const;

export const ADVISOR_GATE_FAILURE_CODES = [
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
  stages: Array<{
    stage: string;
    status: 'started' | 'completed' | 'failed' | 'skipped';
    rawOutput?: string;
    usage: { inputTokens: number; outputTokens: number };
  }>;
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
    };

export function evaluateAdvisorGate(input: AdvisorGateEvaluationInput): AdvisorGateOutput {
  if (input.kind === 'unavailable') return failed(input.code);
  if (input.result.status !== 'planned' || input.result.plan === undefined) {
    return failed('ADVISOR_NOT_PLANNED');
  }
  if (input.result.source !== 'smart-service') return failed('ADVISOR_FELL_BACK');
  if (input.trace === null) return failed('TRACE_UNAVAILABLE');
  if (input.trace.status !== 'completed') return failed('TRACE_NOT_COMPLETED');
  if (input.trace.finalSource !== 'smart-service') return failed('TRACE_SOURCE_MISMATCH');

  const model = sanitizeTraceText(input.trace.model, { maxBytes: 256 }).text.trim();
  if (model.length === 0) return failed('AGENT_MODEL_MISSING');

  for (const stageName of REQUIRED_ADVISOR_STAGES) {
    const stage = input.trace.stages.find(({ stage: candidate }) => candidate === stageName);
    if (stage === undefined) return failed('REQUIRED_STAGE_MISSING');
    if (stage.status !== 'completed') return failed('REQUIRED_STAGE_NOT_COMPLETED');
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
  if (!nonnegativeFinite(input.latencyMs)) return failed('ADVISOR_LATENCY_INVALID');

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

function failed(code: AdvisorGateFailureCode): AdvisorGateOutput {
  return { gate: 'advisor-saved', status: 'failed', code };
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function nonnegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
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
    { AgentSdkAdapter },
    { AgentRunTraceStore },
    { AbyssAdvisorService },
    { AbyssScenarioService },
    { CharacterKnowledgeStore },
    { KnowledgeBundleStore },
    { AdvisorKnowledgeService },
    { KnowledgeCoverageGate },
    { GuideResearchCache },
    { GuideResearchAgent },
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
    trace,
    citationPolicy: {
      supportsCharacter: (citationId, characterId, archetypeId) =>
        strategyKnowledge.supportsCharacterCitation(citationId, characterId, archetypeId)
    }
  });

  const floor = Math.max(...scenarioView.scenario.floors.map(({ floor }) => floor));
  const startedAt = Date.now();
  const result = await advisor.recommend({
    correlationId: `advisor-saved-gate-${Date.now().toString(36)}`,
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
  });

  return evaluateAdvisorGate({
    kind: 'run',
    result,
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
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = output.status === 'passed' ? 0 : 1;
  const { app } = await import('electron');
  app.quit();
}

if (process.versions.electron !== undefined) {
  void main();
}
