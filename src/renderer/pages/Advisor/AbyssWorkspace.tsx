import { useEffect, useMemo, useRef, useState } from 'react';

import type { CharacterProfile, PersistedProfile } from '../../../shared/domain';
import type {
  AbyssAdvisorProgressStep,
  AbyssAdvisorResult,
  AbyssScenarioView
} from '../../../shared/abyss-advisor';
import type { EnemyInstance, EnemyWave, PlayerPreferences } from '../../../shared/scenario-v2';
import { EmptyState } from '../../components/ui/EmptyState';
import { GtaButton } from '../../components/ui/GtaButton';
import { useI18n } from '../../i18n';
import { api } from '../../ipc';
import {
  characterElementLabel,
  cycleCharacterIntervention,
  enemyDisplayName,
  localizedResultText,
  mechanicLabels,
  progressStepLabel,
  type CharacterInterventionState,
  type PresentationLocale
} from './abyss-presentation';
import type { HistoryRerunIntent } from '../History/history-presentation';
import { historySourceChangedNotice, prepareAbyssRerun } from './history-rerun-prefill';

interface AbyssWorkspaceProps {
  uid: string;
  historyRerun?: Extract<HistoryRerunIntent, { mode: 'spiral-abyss' }>;
  onHistoryRerunConsumed?: (historyId: string) => void;
}

const PROGRESS_STEPS: AbyssAdvisorProgressStep[] = [
  'reading-roster',
  'analyzing-rules',
  'generating-teams',
  'checking-conflicts',
  'writing-tactics'
];

const DEFAULT_PREFERENCES: PlayerPreferences = {
  comfort: 'off',
  survival: 'off',
  lowInvestment: 'off',
  noBuildChange: false
};

export function AbyssWorkspace({ uid, historyRerun, onHistoryRerunConsumed }: AbyssWorkspaceProps) {
  const { locale } = useI18n();
  const language: PresentationLocale = locale === 'en-US' ? 'en' : 'zh';
  const isEnglish = language === 'en';
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
  const requestSequence = useRef(0);
  const activeCorrelation = useRef<string | null>(null);
  const pendingHistoryRerun = useRef(historyRerun);
  const historyConsumedCallback = useRef(onHistoryRerunConsumed);
  historyConsumedCallback.current = onHistoryRerunConsumed;
  const [historyNotice, setHistoryNotice] = useState('');

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
        if (nextScenario.status === 'ready') {
          const defaultFloor = nextScenario.scenario.floors[0]?.floor ?? null;
          setFloorNumber(defaultFloor);
          const rerun = pendingHistoryRerun.current;
          if (rerun && nextProfile) {
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
          }
        }
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

  function resetPlan() {
    requestSequence.current += 1;
    setResult(null);
    setResultNeedsUpdate(false);
    setActiveStep(null);
    if (running) {
      setRunning(false);
      cancelActiveRequest();
    }
  }

  function markPlanNeedsUpdate() {
    requestSequence.current += 1;
    setActiveStep(null);
    setResultNeedsUpdate(result?.status === 'planned');
    if (result?.status !== 'planned') setResult(null);
    if (running) {
      setRunning(false);
      cancelActiveRequest();
    }
  }

  function togglePreference(key: 'comfort' | 'survival' | 'lowInvestment' | 'noBuildChange') {
    setPreferences((previous) =>
      key === 'noBuildChange'
        ? { ...previous, noBuildChange: !previous.noBuildChange }
        : { ...previous, [key]: previous[key] === 'high' ? 'off' : 'high' }
    );
    markPlanNeedsUpdate();
  }

  function cycleCharacter(id: string) {
    setInterventions((previous) => ({
      ...previous,
      [id]: cycleCharacterIntervention(previous[id] ?? 'neutral')
    }));
    markPlanNeedsUpdate();
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
      if (requestSequence.current === requestId) {
        setLoadError('generate');
      }
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

  if (loadError) {
    return (
      <div className="gta-abyss-unavailable" role="alert">
        <EmptyState kind="offline" locale={language} />
        <p>
          {loadError === 'load'
            ? isEnglish
              ? 'Spiral Abyss data could not be loaded. Try again later.'
              : '读取深境螺旋资料失败，请稍后重试。'
            : isEnglish
              ? 'The plan could not be generated. Character and challenge data were not changed.'
              : '生成方案时发生错误；角色与挑战资料没有被修改。'}
        </p>
      </div>
    );
  }
  if (!scenarioView || !profile) {
    return (
      <div className="gta-abyss-unavailable">
        {isEnglish ? 'Loading roster and challenge data…' : '正在读取角色与挑战资料…'}
      </div>
    );
  }
  if (scenarioView.status === 'unavailable') {
    return (
      <section className="gta-abyss-unavailable" aria-labelledby="abyss-unavailable-title">
        <span className="gta-page-kicker">{isEnglish ? 'Spiral Abyss' : '深境螺旋'}</span>
        <div id="abyss-unavailable-title">
          <EmptyState kind="offline" locale={language} />
        </div>
        <p>
          {isEnglish
            ? 'Verified challenge data is unavailable. You can still review the roster and saved plans; new plans require verified data.'
            : `${scenarioView.message} 你仍可查看角色与历史方案；恢复可信资料后才能生成新方案。`}
        </p>
      </section>
    );
  }
  const readyScenario = scenarioView.scenario;

  return (
    <section className="gta-abyss-workspace" aria-labelledby="abyss-workspace-title">
      <header className="gta-abyss-heading">
        <div>
          <span className="gta-page-kicker">
            {isEnglish ? 'Joint two-team planning' : '双队联合规划'}
          </span>
          <h3 id="abyss-workspace-title">{isEnglish ? 'Spiral Abyss planner' : '深境螺旋战线'}</h3>
          <p>
            {isEnglish
              ? 'Review both halves, then lock or exclude characters. Both teams are built together and checked for overlap.'
              : '先确认上下半敌情，再锁定或排除角色。两队会一次生成并检查抢人冲突。'}
          </p>
        </div>
        <div className="gta-abyss-data-stamp">
          <span>{isEnglish ? 'Data version' : '资料版本'}</span>
          <strong>
            {scenarioView.trust === 'development-sample'
              ? readyScenario.meta.dataVersion.replace(
                  /^development\./,
                  isEnglish ? 'Practice · ' : '演练 · '
                )
              : readyScenario.meta.dataVersion}
          </strong>
        </div>
      </header>

      {scenarioView.trust === 'development-sample' && (
        <div className="gta-abyss-sample-banner" role="status">
          <strong>
            {isEnglish ? 'Practice data — not the current cycle' : '演练资料，不代表本期'}
          </strong>
          <span>
            {isEnglish
              ? 'These enemies and rules are original interaction samples, not live-server cycle data.'
              : '以下敌人与规则只用于验证交互和约束；不会冒充正式服当前周期。'}
          </span>
        </div>
      )}
      {historyNotice && (
        <div className="gta-abyss-sample-banner is-history-prefill" role="status">
          <strong>{isEnglish ? 'Saved plan ready' : '旧方案已准备'}</strong>
          <span>
            {isEnglish
              ? 'Available saved choices were restored. Review them before generating; the smart service will not start automatically.'
              : historyNotice}
          </span>
        </div>
      )}
      {scenarioReadOnly && (
        <div className="gta-abyss-sample-banner" role="status">
          <strong>{isEnglish ? 'Outdated data — view only' : '资料已过期，仅供查看'}</strong>
          <span>
            {isEnglish
              ? 'Verified data could not be refreshed. New plans are disabled to avoid misleading results.'
              : '正式数据刷新失败或已失效；为避免误导，暂时不能据此生成新方案。'}
          </span>
        </div>
      )}
      {scenarioView.trust === 'production' && scenarioView.refreshWarning && !scenarioReadOnly && (
        <div className="gta-abyss-sample-banner is-refresh-warning" role="status">
          <strong>
            {isEnglish ? 'Using the latest verified snapshot' : '正在使用最近一次已确认资料'}
          </strong>
          <span>
            {isEnglish
              ? 'Refresh did not complete. You can still generate cautiously; check the data version.'
              : `${scenarioView.refreshWarning} 仍可谨慎生成方案，请留意资料版本。`}
          </span>
        </div>
      )}

      <nav
        className="gta-abyss-targets"
        aria-label={isEnglish ? 'Choose Spiral Abyss target' : '选择深境螺旋目标'}
      >
        <div
          className="gta-abyss-floor-tabs"
          role="group"
          aria-label={isEnglish ? 'Choose floor' : '选择楼层'}
        >
          {readyScenario.floors.map(({ floor: number }) => (
            <button
              key={number}
              type="button"
              disabled={running}
              aria-pressed={floorNumber === number}
              onClick={() => {
                setFloorNumber(number);
                setChamberNumber('all');
                resetPlan();
              }}
            >
              {isEnglish ? `Floor ${number}` : `${number} 层`}
            </button>
          ))}
        </div>
        <label>
          <span>{isEnglish ? 'Target chamber' : '目标房间'}</span>
          <select
            disabled={running}
            value={chamberNumber}
            onChange={(event) => {
              setChamberNumber(event.target.value === 'all' ? 'all' : Number(event.target.value));
              resetPlan();
            }}
          >
            <option value="all">
              {isEnglish ? 'All chambers · fixed teams' : '全部房间 · 固定双队'}
            </option>
            {floor?.chambers.map(({ chamber }) => (
              <option key={chamber} value={chamber}>
                {isEnglish ? `Chamber ${chamber}` : `第 ${chamber} 间`}
              </option>
            ))}
          </select>
        </label>
      </nav>

      <div className="gta-abyss-blessing">
        <span>
          {scenarioView.trust === 'development-sample'
            ? isEnglish
              ? 'Practice blessing'
              : '演练增益'
            : isEnglish
              ? 'Current blessing'
              : '本期祝福'}
        </span>
        <p>
          {isEnglish && /[\u3400-\u9fff]/u.test(readyScenario.blessing.description)
            ? 'Blessing details are available in the published challenge data.'
            : readyScenario.blessing.description}
        </p>
      </div>

      <div className="gta-abyss-halves" aria-label={isEnglish ? 'Enemies by half' : '上下半敌情'}>
        <AbyssHalf
          title={isEnglish ? 'First-half enemies' : '上半敌情'}
          half="first"
          chambers={selectedChambers}
          locale={language}
        />
        <AbyssHalf
          title={isEnglish ? 'Second-half enemies' : '下半敌情'}
          half="second"
          chambers={selectedChambers}
          locale={language}
        />
      </div>

      <section className="gta-abyss-controls" aria-labelledby="abyss-preference-title">
        <div className="gta-abyss-control-heading">
          <div>
            <span className="gta-page-kicker">{isEnglish ? 'Your choices' : '你的取舍'}</span>
            <h4 id="abyss-preference-title">
              {isEnglish ? 'Preferences and character choices' : '偏好与角色干预'}
            </h4>
          </div>
          <p>
            {isEnglish
              ? 'Character buttons cycle through: neutral → locked → excluded.'
              : '角色按钮依次切换：未设置 → 锁定 → 排除。'}
          </p>
        </div>
        <div
          className="gta-abyss-preferences"
          role="group"
          aria-label={isEnglish ? 'Team preferences' : '配队偏好'}
        >
          <PreferenceChip
            label={isEnglish ? 'Simple rotations' : '操作简单'}
            disabled={running}
            active={preferences.comfort === 'high'}
            onClick={() => togglePreference('comfort')}
          />
          <PreferenceChip
            label={isEnglish ? 'Prioritize survival' : '生存优先'}
            disabled={running}
            active={preferences.survival === 'high'}
            onClick={() => togglePreference('survival')}
          />
          <PreferenceChip
            label={isEnglish ? 'Lower investment' : '低练度'}
            disabled={running}
            active={preferences.lowInvestment === 'high'}
            onClick={() => togglePreference('lowInvestment')}
          />
          <PreferenceChip
            label={isEnglish ? 'Keep current builds' : '不换装备'}
            disabled={running}
            active={preferences.noBuildChange}
            onClick={() => togglePreference('noBuildChange')}
          />
        </div>
        <div className="gta-abyss-roster-toolbar">
          <label>
            <span className="gta-visually-hidden">
              {isEnglish ? 'Search available characters' : '搜索可用角色'}
            </span>
            <input
              type="search"
              aria-label={isEnglish ? 'Search available characters' : '搜索可用角色'}
              placeholder={isEnglish ? 'Search available characters' : '搜索可用角色'}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <span>
            {isEnglish
              ? `${lockedCharacterIds.length} / 8 locked · ${excludedCharacterIds.length} excluded`
              : `已锁定 ${lockedCharacterIds.length} / 8 · 已排除 ${excludedCharacterIds.length}`}
          </span>
        </div>
        {tooManyLocks && (
          <p className="gta-abyss-inline-error" role="alert">
            {isEnglish
              ? `At most 8 characters can be locked. Unlock at least ${lockedCharacterIds.length - 8}.`
              : `最多锁定 8 名角色；请先取消至少 ${lockedCharacterIds.length - 8} 名。`}
          </p>
        )}
        <div className="gta-abyss-roster" aria-label={isEnglish ? 'Character choices' : '角色干预'}>
          {characters.map((character) => (
            <CharacterInterventionButton
              key={character.id}
              character={character}
              disabled={running}
              state={interventions[String(character.id)] ?? 'neutral'}
              locale={language}
              onClick={() => cycleCharacter(String(character.id))}
            />
          ))}
        </div>
        <div className="gta-abyss-runbar">
          {resultNeedsUpdate && result?.status === 'planned' ? (
            <>
              <GtaButton
                onClick={() => void generatePlan('firstHalf')}
                disabled={
                  running || tooManyLocks || selectedChambers.length === 0 || scenarioReadOnly
                }
              >
                {isEnglish ? 'Recalculate first half' : '只重算上半'}
              </GtaButton>
              <GtaButton
                onClick={() => void generatePlan('secondHalf')}
                disabled={
                  running || tooManyLocks || selectedChambers.length === 0 || scenarioReadOnly
                }
              >
                {isEnglish ? 'Recalculate second half' : '只重算下半'}
              </GtaButton>
              <GtaButton
                tone="ghost"
                onClick={() => void generatePlan()}
                disabled={
                  running || tooManyLocks || selectedChambers.length === 0 || scenarioReadOnly
                }
              >
                {isEnglish ? 'Recalculate both teams' : '完整重算'}
              </GtaButton>
            </>
          ) : (
            <GtaButton
              onClick={() => void generatePlan()}
              disabled={
                running || tooManyLocks || selectedChambers.length === 0 || scenarioReadOnly
              }
            >
              {running
                ? isEnglish
                  ? 'Building both teams…'
                  : '正在生成双队…'
                : isEnglish
                  ? 'Generate both teams'
                  : '生成上下半方案'}
            </GtaButton>
          )}
          {running && (
            <GtaButton tone="ghost" onClick={cancelPlan}>
              {isEnglish ? 'Cancel generation' : '取消生成'}
            </GtaButton>
          )}
          {resultNeedsUpdate && (
            <span className="is-pending">
              {isEnglish
                ? 'Update needed · recalculate the affected half and keep the other team.'
                : '待更新 · 可只重算受影响半场，另一半保持原样。'}
            </span>
          )}
        </div>
      </section>

      {(running || activeStep) && (
        <ol
          className="gta-abyss-progress"
          aria-label={isEnglish ? 'Team planning progress' : '配队进度'}
          aria-live="polite"
        >
          {PROGRESS_STEPS.map((step) => {
            const currentIndex = activeStep ? PROGRESS_STEPS.indexOf(activeStep) : -1;
            const index = PROGRESS_STEPS.indexOf(step);
            const done = Boolean(result) || index < currentIndex;
            return (
              <li
                key={step}
                className={done ? 'is-done' : index === currentIndex ? 'is-active' : ''}
              >
                <span aria-hidden="true">{done ? '✓' : index + 1}</span>
                {progressStepLabel(step, language)}
              </li>
            );
          })}
        </ol>
      )}

      {result && (
        <AbyssResult
          result={result}
          profile={profile}
          pending={resultNeedsUpdate}
          locale={language}
        />
      )}
    </section>
  );
}

function AbyssHalf({
  title,
  half,
  chambers,
  locale
}: {
  title: string;
  half: 'first' | 'second';
  chambers: Array<{
    chamber: number;
    firstHalf: { waves: EnemyWave[] };
    secondHalf: { waves: EnemyWave[] };
    targetSeconds?: number;
  }>;
  locale: PresentationLocale;
}) {
  const isEnglish = locale === 'en';
  return (
    <section className={`gta-abyss-half gta-abyss-half--${half}`}>
      <h4>{title}</h4>
      {chambers.map((chamber) => (
        <div key={chamber.chamber} className="gta-abyss-chamber">
          <div className="gta-abyss-chamber-title">
            <strong>{isEnglish ? `Chamber ${chamber.chamber}` : `第 ${chamber.chamber} 间`}</strong>
            {chamber.targetSeconds && (
              <span>
                {isEnglish
                  ? `Combined target: ${chamber.targetSeconds}s`
                  : `目标总时长 ${chamber.targetSeconds} 秒`}
              </span>
            )}
          </div>
          {(half === 'first' ? chamber.firstHalf.waves : chamber.secondHalf.waves).map(
            (wave, index) => (
              <div key={wave.id} className="gta-abyss-wave">
                <span className="gta-abyss-wave-index">
                  {isEnglish ? `Wave ${index + 1}` : `第 ${index + 1} 波`}
                </span>
                {wave.enemies.map((enemy) => (
                  <EnemyRow key={enemy.enemy.id} enemy={enemy} locale={locale} />
                ))}
              </div>
            )
          )}
        </div>
      ))}
    </section>
  );
}

function EnemyRow({ enemy, locale }: { enemy: EnemyInstance; locale: PresentationLocale }) {
  const isEnglish = locale === 'en';
  const labels = mechanicLabels(enemy.mechanics, locale);
  return (
    <article className="gta-abyss-enemy">
      <div>
        <strong>
          {enemyDisplayName(enemy, locale)} <small>×{enemy.count}</small>
        </strong>
        <span>{isEnglish ? `Level ${enemy.level}` : `等级 ${enemy.level}`}</span>
      </div>
      {labels.length > 0 ? (
        <ul>
          {labels.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      ) : (
        <p>{isEnglish ? 'No special mechanics are listed.' : '资料未标注特殊机制'}</p>
      )}
    </article>
  );
}

function PreferenceChip({
  label,
  active,
  disabled,
  onClick
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" aria-pressed={active} disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}

function CharacterInterventionButton({
  character,
  state,
  disabled,
  locale,
  onClick
}: {
  character: CharacterProfile;
  state: CharacterInterventionState;
  disabled: boolean;
  locale: PresentationLocale;
  onClick: () => void;
}) {
  const isEnglish = locale === 'en';
  const stateLabel =
    state === 'locked'
      ? isEnglish
        ? 'Locked'
        : '锁定'
      : state === 'excluded'
        ? isEnglish
          ? 'Excluded'
          : '排除'
        : isEnglish
          ? 'Neutral'
          : '未设置';
  return (
    <button
      type="button"
      className={`gta-abyss-character is-${state}`}
      aria-label={
        isEnglish
          ? `${character.name}, current state: ${stateLabel}; press to change`
          : `${character.name}，当前：${stateLabel}；按下切换`
      }
      aria-pressed={state === 'locked'}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="gta-abyss-character-mark" aria-hidden="true">
        {state === 'locked' ? '◆' : state === 'excluded' ? '×' : '·'}
      </span>
      <span>
        <strong>{character.name}</strong>
        <small>
          {isEnglish
            ? `Level ${character.level ?? 'unknown'} · ${characterElementLabel(character.element, locale)}`
            : `等级 ${character.level ?? '未知'} · ${characterElementLabel(character.element, locale)}元素`}
        </small>
      </span>
      <em>{stateLabel}</em>
    </button>
  );
}

function AbyssResult({
  result,
  profile,
  pending,
  locale
}: {
  result: AbyssAdvisorResult;
  profile: PersistedProfile;
  pending: boolean;
  locale: PresentationLocale;
}) {
  const isEnglish = locale === 'en';
  if (result.status === 'blocked') {
    const searchBudgetExceeded = result.issues.some(
      ({ code }) => code === 'SEARCH_BUDGET_EXCEEDED'
    );
    return (
      <section
        className="gta-abyss-result gta-abyss-result--blocked"
        aria-labelledby="abyss-blocked-title"
      >
        <h4 id="abyss-blocked-title">
          {isEnglish ? 'Two complete teams cannot be built yet' : '暂时无法组成两支完整队伍'}
        </h4>
        <ul>
          {result.issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>
              {isEnglish
                ? `Planning constraint ${index + 1} is not satisfied by the current choices.`
                : issue.message}
            </li>
          ))}
        </ul>
        <p>
          {isEnglish
            ? searchBudgetExceeded
              ? 'The search limit was reached; this does not prove the roster has no solution. Narrow the pool or lock key characters and try again.'
              : 'Reduce locked or excluded characters, or update the roster before trying again.'
            : searchBudgetExceeded
              ? '这不代表当前角色一定无解。请缩小角色池，或先锁定关键角色再试。'
              : '请减少锁定或排除角色，或补充角色资料后再试。'}
        </p>
      </section>
    );
  }
  const characterById = new Map(
    profile.characters.map((character) => [String(character.id), character])
  );
  return (
    <section className="gta-abyss-result" aria-labelledby="abyss-result-title">
      <header>
        <div>
          <span className="gta-page-kicker">
            {isEnglish ? 'Fixed two-team plan' : '固定双队方案'}
          </span>
          <h4 id="abyss-result-title">
            {isEnglish ? 'No character overlap between halves' : '上下半零重复'}
          </h4>
          {pending && (
            <span className="gta-abyss-pending-badge">
              {isEnglish ? 'Update needed' : '待更新'}
            </span>
          )}
        </div>
        <div className={`gta-abyss-source is-${result.source}`}>
          {result.source === 'smart-service'
            ? isEnglish
              ? 'Smart service'
              : '智能服务'
            : isEnglish
              ? 'Local rules'
              : '本地规则'}
        </div>
      </header>
      <p>{isEnglish ? result.narrative.summary['en-US'] : result.narrative.summary['zh-CN']}</p>
      <div className="gta-abyss-result-teams">
        <ResultTeam
          title={isEnglish ? 'First-half team' : '上半队伍'}
          ids={result.plan.firstHalfTeam.characterIds}
          purpose={localizedResultText(
            result.plan.firstHalfTeam.purpose,
            locale,
            'Covers the selected first-half encounters.'
          )}
          rotationNotes={result.plan.firstHalfTeam.rotationNotes.map((text) =>
            localizedResultText(text, locale, 'Adjust the rotation to energy and wave transitions.')
          )}
          characters={characterById}
          locale={locale}
        />
        <ResultTeam
          title={isEnglish ? 'Second-half team' : '下半队伍'}
          ids={result.plan.secondHalfTeam.characterIds}
          purpose={localizedResultText(
            result.plan.secondHalfTeam.purpose,
            locale,
            'Covers the selected second-half encounters.'
          )}
          rotationNotes={result.plan.secondHalfTeam.rotationNotes.map((text) =>
            localizedResultText(text, locale, 'Adjust the rotation to energy and wave transitions.')
          )}
          characters={characterById}
          locale={locale}
        />
      </div>
      {result.teamRisks.length > 0 && (
        <div className="gta-abyss-result-notes" aria-label={isEnglish ? 'Team risks' : '队伍风险'}>
          {result.teamRisks.map((risk) => (
            <div key={`${risk.half}:${risk.code}`}>
              <strong>
                {risk.half === 'first'
                  ? isEnglish
                    ? 'First-half risk'
                    : '上半队伍风险'
                  : isEnglish
                    ? 'Second-half risk'
                    : '下半队伍风险'}
              </strong>
              <span>{risk.narrative[isEnglish ? 'en-US' : 'zh-CN']}</span>
            </div>
          ))}
        </div>
      )}
      <div className="gta-abyss-tactics">
        {result.plan.chambers.map((chamber) => (
          <article key={`${chamber.floor}-${chamber.chamber}`}>
            <h5>
              {isEnglish
                ? `Floor ${chamber.floor} · Chamber ${chamber.chamber}`
                : `${chamber.floor} 层 · 第 ${chamber.chamber} 间`}
            </h5>
            <div>
              <strong>{isEnglish ? 'First-half tactics' : '上半怎么打'}</strong>
              {chamber.firstHalf.tactics.map((text) => (
                <p key={text}>
                  {localizedResultText(
                    text,
                    locale,
                    'Use a conservative rotation and verify enemy behavior in combat.'
                  )}
                </p>
              ))}
              <small>
                {isEnglish ? 'Time risk: ' : '超时风险：'}
                {chamber.firstHalf.risks
                  .map((text) =>
                    localizedResultText(
                      text,
                      locale,
                      'Combat timing requires in-game verification.'
                    )
                  )
                  .join(isEnglish ? '; ' : '；') ||
                  (isEnglish ? 'No additional notes' : '暂无额外提示')}
              </small>
              <small>
                {isEnglish ? 'Substitutions: ' : '替换建议：'}
                {chamber.firstHalf.substitutionNotes
                  .map((text) =>
                    localizedResultText(
                      text,
                      locale,
                      'Regenerate both teams after changing characters.'
                    )
                  )
                  .join(isEnglish ? '; ' : '；') ||
                  (isEnglish
                    ? 'Adjust characters, then regenerate both teams'
                    : '调整角色后重新生成完整双队')}
              </small>
            </div>
            <div>
              <strong>{isEnglish ? 'Second-half tactics' : '下半怎么打'}</strong>
              {chamber.secondHalf.tactics.map((text) => (
                <p key={text}>
                  {localizedResultText(
                    text,
                    locale,
                    'Use a conservative rotation and verify enemy behavior in combat.'
                  )}
                </p>
              ))}
              <small>
                {isEnglish ? 'Time risk: ' : '超时风险：'}
                {chamber.secondHalf.risks
                  .map((text) =>
                    localizedResultText(
                      text,
                      locale,
                      'Combat timing requires in-game verification.'
                    )
                  )
                  .join(isEnglish ? '; ' : '；') ||
                  (isEnglish ? 'No additional notes' : '暂无额外提示')}
              </small>
              <small>
                {isEnglish ? 'Substitutions: ' : '替换建议：'}
                {chamber.secondHalf.substitutionNotes
                  .map((text) =>
                    localizedResultText(
                      text,
                      locale,
                      'Regenerate both teams after changing characters.'
                    )
                  )
                  .join(isEnglish ? '; ' : '；') ||
                  (isEnglish
                    ? 'Adjust characters, then regenerate both teams'
                    : '调整角色后重新生成完整双队')}
              </small>
            </div>
          </article>
        ))}
      </div>
      <div className="gta-abyss-result-notes">
        <div>
          <strong>{isEnglish ? 'Recommendation confidence' : '建议把握'}</strong>
          <span>
            {result.plan.confidence === 'high'
              ? isEnglish
                ? 'High'
                : '较高'
              : result.plan.confidence === 'medium'
                ? isEnglish
                  ? 'Medium'
                  : '中等'
                : isEnglish
                  ? 'Low'
                  : '较低'}
          </span>
        </div>
        {result.warnings.length > 0 && (
          <div>
            <strong>{isEnglish ? 'Watch for' : '需要留意'}</strong>
            <span>
              {result.warnings
                .map((text) =>
                  localizedResultText(
                    text,
                    locale,
                    'Verify this recommendation against the current roster and combat conditions.'
                  )
                )
                .join(isEnglish ? '; ' : '；')}
            </span>
          </div>
        )}
        {result.assumptions.length > 0 && (
          <div>
            <strong>{isEnglish ? 'This recommendation assumes' : '本次建议基于'}</strong>
            <span>
              {result.assumptions
                .map((text) =>
                  localizedResultText(
                    text,
                    locale,
                    'Only verified roster and challenge facts are treated as confirmed.'
                  )
                )
                .join(isEnglish ? '; ' : '；')}
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function ResultTeam({
  title,
  ids,
  purpose,
  rotationNotes,
  characters,
  locale
}: {
  title: string;
  ids: string[];
  purpose: string;
  rotationNotes: string[];
  characters: Map<string, CharacterProfile>;
  locale: PresentationLocale;
}) {
  const isEnglish = locale === 'en';
  return (
    <section>
      <h5>{title}</h5>
      <p>{purpose}</p>
      {rotationNotes.length > 0 && (
        <p className="gta-abyss-rotation">
          {isEnglish ? 'Rotation: ' : '循环：'}
          {rotationNotes.join(isEnglish ? '; ' : '；')}
        </p>
      )}
      <div className="gta-abyss-result-roster">
        {ids.map((id) => {
          const character = characters.get(id);
          return (
            <span key={id} data-result-character-id={id}>
              <strong>{character?.name ?? (isEnglish ? 'Unknown character' : '未知角色')}</strong>
              <small>
                {character
                  ? isEnglish
                    ? `${characterElementLabel(character.element, locale)} · Level ${character.level ?? 'unknown'}`
                    : `${characterElementLabel(character.element, locale)}元素 · 等级 ${character.level ?? '未知'}`
                  : isEnglish
                    ? 'Saved character data unavailable'
                    : `角色编号 ${id}`}
              </small>
            </span>
          );
        })}
      </div>
    </section>
  );
}
