import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AgentRunTrace } from '../../../../shared/agent-run-trace';
import type {
  AbyssAdvisorProgressStep,
  AbyssAdvisorResult,
  AbyssScenarioView
} from '../../../../shared/abyss-advisor';
import type { PersistedProfile } from '../../../../shared/domain';
import type { PlayerPreferences } from '../../../../shared/scenario-v2';
import { useI18n } from '../../../i18n';
import { api } from '../../../ipc';
import type { HistoryRerunIntent } from '../../History/history-presentation';
import {
  cycleCharacterIntervention,
  type CharacterInterventionState,
  type PresentationLocale
} from '../abyss-presentation';
import { historySourceChangedNotice, prepareAbyssRerun } from '../history-rerun-prefill';

export const DEFAULT_PREFERENCES: PlayerPreferences = {
  comfort: 'off',
  survival: 'off',
  lowInvestment: 'off',
  noBuildChange: true
};

export interface UseAbyssWorkbenchOptions {
  uid: string;
  historyRerun?: Extract<HistoryRerunIntent, { mode: 'spiral-abyss' }>;
  onHistoryRerunConsumed?: (historyId: string) => void;
}

export function useAbyssWorkbench({
  uid,
  historyRerun,
  onHistoryRerunConsumed
}: UseAbyssWorkbenchOptions) {
  const { locale } = useI18n();
  const language: PresentationLocale = locale === 'en-US' ? 'en' : 'zh';
  const [scenarioView, setScenarioView] = useState<AbyssScenarioView | null>(null);
  const [profile, setProfile] = useState<PersistedProfile | null>(null);
  const [loadError, setLoadError] = useState<'load' | 'generate' | ''>('');
  const [floorNumber, setFloorNumber] = useState<number | null>(null);
  const [chamberNumber, setChamberNumber] = useState<number | 'all'>('all');
  const [preferences, setPreferences] = useState<PlayerPreferences>(DEFAULT_PREFERENCES);
  const [interventions, setInterventions] = useState<Record<string, CharacterInterventionState>>(
    {}
  );
  const [search, setSearch] = useState('');
  const [result, setResult] = useState<AbyssAdvisorResult | null>(null);
  const [resultNeedsUpdate, setResultNeedsUpdate] = useState(false);
  const [activeStep, setActiveStep] = useState<AbyssAdvisorProgressStep | null>(null);
  const [running, setRunning] = useState(false);
  const [historyNotice, setHistoryNotice] = useState('');
  const [traceOpen, setTraceOpen] = useState(false);
  const [trace, setTrace] = useState<AgentRunTrace | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState(false);
  const requestSequence = useRef(0);
  const traceRequestSequence = useRef(0);
  const activeCorrelation = useRef<string | null>(null);
  const pendingHistoryRerun = useRef(historyRerun);
  const historyConsumedCallback = useRef(onHistoryRerunConsumed);
  historyConsumedCallback.current = onHistoryRerunConsumed;

  function cancelActiveRequest() {
    const correlationId = activeCorrelation.current;
    activeCorrelation.current = null;
    if (correlationId) void api.abyssAdvisor.cancel({ correlationId });
  }

  useEffect(() => {
    let active = true;
    requestSequence.current += 1;
    cancelActiveRequest();
    setScenarioView(null);
    setProfile(null);
    setLoadError('');
    setFloorNumber(null);
    setChamberNumber('all');
    setPreferences(DEFAULT_PREFERENCES);
    setInterventions({});
    setHistoryNotice('');
    setResult(null);
    setResultNeedsUpdate(false);
    setActiveStep(null);
    setRunning(false);

    void Promise.all([api.abyssAdvisor.getScenario(), api.profile.get({ uid })])
      .then(([nextScenario, nextProfile]) => {
        if (!active) return;
        setScenarioView(nextScenario);
        setProfile(nextProfile);
        if (nextScenario.status !== 'ready') return;
        const defaultFloor = nextScenario.scenario.floors[0]?.floor ?? null;
        setFloorNumber(defaultFloor);
        const rerun = pendingHistoryRerun.current;
        if (!rerun || !nextProfile) return;
        const prepared = prepareAbyssRerun(
          rerun,
          uid,
          nextScenario.scenario.floors.map(({ floor }) => floor),
          nextProfile.characters.map(({ id }) => String(id)),
          {
            scenarioId: nextScenario.scenario.id,
            dataVersion: nextScenario.scenario.meta.dataVersion
          }
        );
        if (prepared.status === 'blocked') {
          setHistoryNotice('这份旧方案属于另一个 UID；已保留旧方案查看，但没有带入当前账号。');
        } else {
          const selectedFloor = prepared.floor ?? defaultFloor;
          const selectedFloorData = nextScenario.scenario.floors.find(
            ({ floor }) => floor === selectedFloor
          );
          const chamber =
            prepared.chamber &&
            selectedFloorData?.chambers.some(
              ({ chamber: candidate }) => candidate === prepared.chamber
            )
              ? prepared.chamber
              : 'all';
          setFloorNumber(selectedFloor);
          setChamberNumber(chamber);
          // History reruns preserve the explicit value saved with that run.
          setPreferences(prepared.preferences);
          setInterventions({
            ...Object.fromEntries(prepared.lockedCharacterIds.map((id) => [id, 'locked'])),
            ...Object.fromEntries(prepared.excludedCharacterIds.map((id) => [id, 'excluded']))
          });
          setHistoryNotice(
            `${historySourceChangedNotice(prepared, 'zh')}${
              prepared.status === 'adjusted'
                ? `已带入旧方案的可用选择；${
                    prepared.targetUnavailable ? '原楼层已不在当前资料中；' : ''
                  }${
                    prepared.removedCharacterCount > 0
                      ? `${prepared.removedCharacterCount} 名已不在当前角色资料中的角色未带入；`
                      : ''
                  }请检查后再点击生成，不会自动调用智能服务。`
                : '已带入旧方案的楼层、偏好与角色选择。请检查后再点击生成，不会自动调用智能服务。'
            }`
          );
        }
        pendingHistoryRerun.current = undefined;
        historyConsumedCallback.current?.(rerun.historyId);
      })
      .catch(() => {
        if (active) setLoadError('load');
      });

    return () => {
      active = false;
      requestSequence.current += 1;
      cancelActiveRequest();
    };
  }, [uid]);

  useEffect(
    () =>
      api.abyssAdvisor.onEvent((event) => {
        if (event.correlationId === activeCorrelation.current) setActiveStep(event.step);
      }),
    []
  );

  const scenario = scenarioView?.status === 'ready' ? scenarioView.scenario : null;
  const floor = scenario?.floors.find(({ floor: candidate }) => candidate === floorNumber);
  const selectedChambers =
    floor?.chambers.filter(({ chamber }) => chamberNumber === 'all' || chamber === chamberNumber) ??
    [];
  const characters = useMemo(
    () =>
      (profile?.characters ?? [])
        .filter(({ name }) => name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
        .sort(
          (left, right) =>
            (right.level ?? 0) - (left.level ?? 0) || left.name.localeCompare(right.name)
        ),
    [profile, search]
  );
  const lockedCharacterIds = Object.entries(interventions)
    .filter(([, state]) => state === 'locked')
    .map(([id]) => id);
  const excludedCharacterIds = Object.entries(interventions)
    .filter(([, state]) => state === 'excluded')
    .map(([id]) => id);
  const tooManyLocks = lockedCharacterIds.length > 8;
  const scenarioReadOnly =
    scenarioView?.status === 'ready' &&
    scenarioView.trust === 'production' &&
    scenarioView.notCurrent;

  function invalidateResult(reset = false) {
    requestSequence.current += 1;
    setActiveStep(null);
    setResultNeedsUpdate(!reset && result?.status === 'planned');
    if (reset || result?.status !== 'planned') setResult(null);
    if (running) {
      setRunning(false);
      cancelActiveRequest();
    }
  }

  function chooseFloor(value: number) {
    setFloorNumber(value);
    setChamberNumber('all');
    invalidateResult(true);
  }

  function chooseChamber(value: number | 'all') {
    setChamberNumber(value);
    invalidateResult(true);
  }

  function togglePreference(key: keyof PlayerPreferences) {
    setPreferences((previous) =>
      key === 'noBuildChange'
        ? { ...previous, noBuildChange: !previous.noBuildChange }
        : { ...previous, [key]: previous[key] === 'high' ? 'off' : 'high' }
    );
    invalidateResult();
  }

  function cycleCharacter(id: string) {
    setInterventions((previous) => ({
      ...previous,
      [id]: cycleCharacterIntervention(previous[id] ?? 'neutral')
    }));
    invalidateResult();
  }

  async function generatePlan(recomputeHalf?: 'firstHalf' | 'secondHalf') {
    if (!scenario || !floor || tooManyLocks || scenarioReadOnly) return;
    const priorPlan = result?.status === 'planned' ? result.plan : undefined;
    if (recomputeHalf && (!resultNeedsUpdate || !priorPlan)) return;
    const requestId = requestSequence.current + 1;
    const correlationId = `abyss-${Date.now()}-${requestId}`;
    requestSequence.current = requestId;
    activeCorrelation.current = correlationId;
    setRunning(true);
    setLoadError('');
    if (!recomputeHalf) setResult(null);
    setActiveStep('reading-roster');
    try {
      const next = await api.abyssAdvisor.recommend({
        correlationId,
        uid,
        scenarioId: scenario.id,
        dataVersion: scenario.meta.dataVersion,
        locale,
        floor: floor.floor,
        ...(chamberNumber === 'all' ? {} : { chamber: chamberNumber }),
        preferences,
        lockedCharacterIds,
        excludedCharacterIds,
        ...(recomputeHalf && priorPlan ? { priorPlan, recomputeHalf } : {})
      });
      if (requestSequence.current === requestId) {
        setResult(next);
        setResultNeedsUpdate(false);
      }
    } catch {
      if (requestSequence.current === requestId) setLoadError('generate');
    } finally {
      if (requestSequence.current === requestId) {
        activeCorrelation.current = null;
        setRunning(false);
      }
    }
  }

  function cancelPlan() {
    requestSequence.current += 1;
    setRunning(false);
    setActiveStep(null);
    cancelActiveRequest();
  }

  const openTrace = useCallback(() => {
    const requestId = traceRequestSequence.current + 1;
    traceRequestSequence.current = requestId;
    setTraceOpen(true);
    setTraceLoading(true);
    setTraceError(false);
    // Deliberately lazy: generating a result never fetches the trace.
    void api.abyssAdvisor
      .getLatestTrace()
      .then((nextTrace) => {
        if (traceRequestSequence.current === requestId) setTrace(nextTrace);
      })
      .catch(() => {
        if (traceRequestSequence.current === requestId) setTraceError(true);
      })
      .finally(() => {
        if (traceRequestSequence.current === requestId) setTraceLoading(false);
      });
  }, []);

  const closeTrace = useCallback(() => {
    traceRequestSequence.current += 1;
    setTraceOpen(false);
    setTraceLoading(false);
  }, []);

  return {
    locale,
    language,
    scenarioView,
    scenario,
    floor,
    selectedChambers,
    profile,
    loadError,
    floorNumber,
    chamberNumber,
    preferences,
    interventions,
    characters,
    search,
    result,
    resultNeedsUpdate,
    activeStep,
    running,
    historyNotice,
    lockedCharacterIds,
    excludedCharacterIds,
    tooManyLocks,
    scenarioReadOnly,
    traceOpen,
    trace,
    traceLoading,
    traceError,
    setSearch,
    chooseFloor,
    chooseChamber,
    togglePreference,
    cycleCharacter,
    generatePlan,
    cancelPlan,
    openTrace,
    closeTrace
  };
}
