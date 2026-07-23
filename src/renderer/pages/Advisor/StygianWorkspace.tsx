import { useEffect, useMemo, useRef, useState } from 'react';

import type { CharacterProfile, PersistedProfile } from '../../../shared/domain';
import type {
  StygianAdvisorProgressStep,
  StygianAdvisorResult,
  StygianRewardTarget,
  StygianScenario,
  StygianScenarioView
} from '../../../shared/stygian-advisor';
import type { PlayerPreferences } from '../../../shared/scenario-v2';
import {
  clampDifficultyForStygianTarget,
  isStygianTargetDifficultyCompatible
} from '../../../shared/stygian-reward-policy';
import { EmptyState } from '../../components/ui/EmptyState';
import { GtaButton } from '../../components/ui/GtaButton';
import { useI18n } from '../../i18n';
import { api } from '../../ipc';
import {
  characterElementLabel,
  localizedPlanText,
  localizedProfileName,
  narrativeTargetBody,
  type PresentationLocale
} from './abyss-presentation';
import {
  cycleStygianIntervention,
  difficultyDisplayName,
  difficultyModifierLabels,
  difficultySuggestionLabel,
  progressStepLabel,
  reuseRuleSummary,
  rewardTargetLabel,
  scenarioVersionLabel,
  stygianBossDisplayName,
  stygianMechanicLabels,
  type StygianInterventionState
} from './stygian-presentation';
import type { HistoryRerunIntent } from '../History/history-presentation';
import { historySourceChangedNotice, prepareStygianRerun } from './history-rerun-prefill';
import { scenarioUnavailableCopy } from './scenario-unavailable-presentation';

interface StygianWorkspaceProps {
  uid: string;
  historyRerun?: Extract<HistoryRerunIntent, { mode: 'stygian-onslaught' }>;
  onHistoryRerunConsumed?: (historyId: string) => void;
  onBack: () => void;
}

const PROGRESS_STEPS: StygianAdvisorProgressStep[] = [
  'reading-roster',
  'analyzing-rules',
  'allocating-parties',
  'checking-mechanics',
  'writing-guidance'
];

const REWARD_TARGETS: StygianRewardTarget[] = ['primogems', 'high-reward', 'dire-challenge'];

const DEFAULT_PREFERENCES: PlayerPreferences = {
  comfort: 'off',
  survival: 'off',
  lowInvestment: 'off',
  noBuildChange: false
};

export function StygianWorkspace({
  uid,
  historyRerun,
  onHistoryRerunConsumed,
  onBack
}: StygianWorkspaceProps) {
  const { locale } = useI18n();
  const language: PresentationLocale = locale === 'en-US' ? 'en' : 'zh';
  const isEnglish = language === 'en';
  const [scenarioView, setScenarioView] = useState<StygianScenarioView | null>(null);
  const [profile, setProfile] = useState<PersistedProfile | null>(null);
  const [loadError, setLoadError] = useState<'load' | 'generate' | ''>('');
  const [difficultyId, setDifficultyId] = useState('');
  const [target, setTarget] = useState<StygianRewardTarget>('primogems');
  const [preferences, setPreferences] = useState<PlayerPreferences>(DEFAULT_PREFERENCES);
  const [interventions, setInterventions] = useState<Record<string, StygianInterventionState>>({});
  const [search, setSearch] = useState('');
  const [result, setResult] = useState<StygianAdvisorResult | null>(null);
  const [activeStep, setActiveStep] = useState<StygianAdvisorProgressStep | null>(null);
  const [running, setRunning] = useState(false);
  const sequence = useRef(0);
  const activeCorrelation = useRef<string | null>(null);
  const pendingHistoryRerun = useRef(historyRerun);
  const historyConsumedCallback = useRef(onHistoryRerunConsumed);
  historyConsumedCallback.current = onHistoryRerunConsumed;
  const [historyNotice, setHistoryNotice] = useState('');

  useEffect(() => {
    let active = true;
    sequence.current += 1;
    const previousCorrelation = activeCorrelation.current;
    activeCorrelation.current = null;
    if (previousCorrelation) {
      void api.stygianAdvisor.cancel({ correlationId: previousCorrelation });
    }
    setScenarioView(null);
    setProfile(null);
    setLoadError('');
    setHistoryNotice('');
    setResult(null);
    setActiveStep(null);
    setRunning(false);
    void Promise.all([api.stygianAdvisor.getScenario(), api.profile.get({ uid })])
      .then(([nextScenario, nextProfile]) => {
        if (!active) return;
        setScenarioView(nextScenario);
        setProfile(nextProfile);
        if (nextScenario.status === 'ready') {
          const ordered = nextScenario.scenario.difficulties
            .slice()
            .sort((left, right) => left.order - right.order);
          const defaultDifficulty = ordered[0]?.id ?? '';
          setDifficultyId(defaultDifficulty);
          const rerun = pendingHistoryRerun.current;
          if (rerun && nextProfile) {
            const prepared = prepareStygianRerun(
              rerun,
              uid,
              ordered.map(({ id }) => id),
              nextProfile.characters.map(({ id }) => String(id)),
              {
                scenarioId: nextScenario.scenario.id,
                dataVersion: nextScenario.scenario.meta.dataVersion
              }
            );
            if (prepared.status === 'blocked') {
              setHistoryNotice('这份旧方案属于另一个 UID；已保留旧方案查看，但没有带入当前账号。');
            } else {
              setDifficultyId(prepared.difficultyId || defaultDifficulty);
              setTarget(prepared.target);
              setPreferences(prepared.preferences);
              setInterventions({
                ...Object.fromEntries(prepared.lockedCharacterIds.map((id) => [id, 'locked'])),
                ...Object.fromEntries(prepared.excludedCharacterIds.map((id) => [id, 'excluded']))
              });
              setHistoryNotice(
                `${historySourceChangedNotice(prepared, 'zh')}${
                  prepared.status === 'adjusted'
                    ? `已带入旧方案的可用选择；${
                        prepared.targetUnavailable ? '原难度已不在当前资料中；' : ''
                      }${
                        prepared.removedCharacterCount > 0
                          ? `${prepared.removedCharacterCount} 名已不在当前角色资料中的角色未带入；`
                          : ''
                      }请检查后再点击生成，不会自动调用智能服务。`
                    : '已带入旧方案的难度、目标、偏好与角色选择。请检查后再点击生成，不会自动调用智能服务。'
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
      sequence.current += 1;
      const correlationId = activeCorrelation.current;
      activeCorrelation.current = null;
      if (correlationId) void api.stygianAdvisor.cancel({ correlationId });
    };
  }, [uid]);

  useEffect(
    () =>
      api.stygianAdvisor.onEvent((event) => {
        if (event.correlationId === activeCorrelation.current) setActiveStep(event.step);
      }),
    []
  );

  const scenario = scenarioView?.status === 'ready' ? scenarioView.scenario : null;
  const difficulty = scenario?.difficulties.find(({ id }) => id === difficultyId);
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
  const lockLimitExceeded = lockedCharacterIds.length > 12;
  const scenarioReadOnly =
    scenarioView?.status === 'ready' &&
    scenarioView.trust === 'production' &&
    scenarioView.notCurrent;

  function invalidateResult() {
    sequence.current += 1;
    const correlationId = activeCorrelation.current;
    activeCorrelation.current = null;
    setResult(null);
    setActiveStep(null);
    if (running) {
      setRunning(false);
      if (correlationId) void api.stygianAdvisor.cancel({ correlationId });
    }
  }

  function cycleCharacter(id: string) {
    setInterventions((previous) => ({
      ...previous,
      [id]: cycleStygianIntervention(previous[id] ?? 'neutral')
    }));
    invalidateResult();
  }

  function togglePreference(key: 'comfort' | 'survival' | 'lowInvestment' | 'noBuildChange') {
    setPreferences((previous) =>
      key === 'noBuildChange'
        ? { ...previous, noBuildChange: !previous.noBuildChange }
        : { ...previous, [key]: previous[key] === 'high' ? 'off' : 'high' }
    );
    invalidateResult();
  }

  async function generatePlan() {
    if (!scenario || !difficulty || scenarioReadOnly) return;
    const requestId = sequence.current + 1;
    const correlationId = `stygian-${Date.now()}-${requestId}`;
    sequence.current = requestId;
    activeCorrelation.current = correlationId;
    setRunning(true);
    setResult(null);
    setActiveStep('reading-roster');
    setLoadError('');
    try {
      const next = await api.stygianAdvisor.recommend({
        correlationId,
        uid,
        scenarioId: scenario.id,
        dataVersion: scenario.meta.dataVersion,
        locale,
        difficultyId: difficulty.id,
        target,
        preferences,
        lockedCharacterIds,
        excludedCharacterIds
      });
      if (sequence.current === requestId) setResult(next);
    } catch {
      if (sequence.current === requestId) {
        setLoadError('generate');
      }
    } finally {
      if (sequence.current === requestId) {
        activeCorrelation.current = null;
        setRunning(false);
      }
    }
  }

  function cancelPlan() {
    sequence.current += 1;
    const correlationId = activeCorrelation.current;
    activeCorrelation.current = null;
    setRunning(false);
    setActiveStep(null);
    if (correlationId) void api.stygianAdvisor.cancel({ correlationId });
  }

  if (loadError && (!scenarioView || !profile)) {
    return (
      <div className="gta-stygian-unavailable" role="alert">
        <EmptyState kind="offline" locale={language} />
        <p>
          {isEnglish
            ? 'Stygian Onslaught data could not be loaded. Try again later.'
            : '读取幽境危战资料失败，请稍后重试。'}
        </p>
      </div>
    );
  }
  if (!scenarioView || !profile) {
    return (
      <div className="gta-stygian-unavailable">
        {isEnglish ? 'Loading roster and challenge data…' : '正在读取角色与挑战资料…'}
      </div>
    );
  }
  if (scenarioView.status === 'unavailable') {
    return (
      <section className="gta-stygian-unavailable" aria-labelledby="stygian-unavailable-title">
        <GtaButton tone="ghost" onClick={onBack}>
          {isEnglish ? 'Back to challenge selection' : '返回挑战入口'}
        </GtaButton>
        <span className="gta-page-kicker">{isEnglish ? 'Stygian Onslaught' : '幽境危战'}</span>
        <div id="stygian-unavailable-title">
          <EmptyState
            kind="offline"
            locale={language}
            copy={scenarioUnavailableCopy(scenarioView.reason, language)}
          />
        </div>
        <p>
          {isEnglish
            ? 'Verified challenge data is unavailable. You can still review the roster and saved plans.'
            : `${scenarioView.message} 你仍可查看角色与历史方案。`}
        </p>
      </section>
    );
  }
  const readyScenario = scenarioView.scenario;

  return (
    <section className="gta-stygian-workspace" aria-labelledby="stygian-workspace-title">
      <header className="gta-stygian-heading">
        <div>
          <GtaButton tone="ghost" onClick={onBack}>
            {isEnglish ? 'Back to challenge selection' : '返回挑战入口'}
          </GtaButton>
          <span className="gta-page-kicker">
            {isEnglish ? 'Joint three-phase planning' : '三阶段联合规划'}
          </span>
          <h3 id="stygian-workspace-title">
            {isEnglish ? 'Stygian Onslaught planner' : '幽境危战作战台'}
          </h3>
          <p>
            {isEnglish
              ? 'Choose a difficulty and reward goal, then allocate all three teams under the current reuse rules.'
              : '先选择目标难度和奖励，再按当期复用规则一次分配三队。'}
          </p>
        </div>
        <div className="gta-stygian-data-stamp">
          <span>{isEnglish ? 'Data version' : '资料版本'}</span>
          <strong>{scenarioVersionLabel(scenarioView, language)}</strong>
        </div>
      </header>

      {scenarioView.trust === 'development-sample' && (
        <div className="gta-stygian-banner" role="status">
          <strong>
            {isEnglish ? 'Practice data — not the current cycle' : '演练资料，不代表本期'}
          </strong>
          <span>
            {isEnglish
              ? 'The bosses, difficulty tiers, and rules are original interaction samples, not live-server content.'
              : '三名首领、六档难度与规则均为交互演示，不是正式服当前内容。'}
          </span>
        </div>
      )}
      {historyNotice && (
        <div className="gta-stygian-banner is-history-prefill" role="status">
          <strong>{isEnglish ? 'Saved plan ready' : '旧方案已准备'}</strong>
          <span>
            {isEnglish
              ? 'Available saved choices were restored. Review them before generating; the smart service will not start automatically.'
              : historyNotice}
          </span>
        </div>
      )}
      {scenarioReadOnly && (
        <div className="gta-stygian-banner" role="status">
          <strong>{isEnglish ? 'Outdated data — view only' : '资料已过期，仅供查看'}</strong>
          <span>
            {isEnglish
              ? 'New current-cycle plans are disabled to avoid misleading results.'
              : '为避免误导，暂时不能据此生成本期方案。'}
          </span>
        </div>
      )}
      {scenarioView.trust === 'production' && scenarioView.refreshWarning && !scenarioReadOnly && (
        <div className="gta-stygian-banner is-refresh-warning" role="status">
          <strong>
            {isEnglish ? 'Using the latest verified snapshot' : '正在使用最近一次已确认资料'}
          </strong>
          <span>
            {isEnglish
              ? 'Refresh did not complete. Check the data version before generating.'
              : `${scenarioView.refreshWarning} 请留意资料版本。`}
          </span>
        </div>
      )}

      <section className="gta-stygian-objective" aria-labelledby="stygian-objective-title">
        <div>
          <span className="gta-page-kicker">{isEnglish ? 'Challenge goal' : '挑战目标'}</span>
          <h4 id="stygian-objective-title">
            {isEnglish ? 'Choose difficulty and reward goal' : '选择难度与奖励期待'}
          </h4>
        </div>
        <div
          className="gta-stygian-difficulties"
          role="group"
          aria-label={isEnglish ? 'Choose from six difficulty tiers' : '选择六档难度'}
        >
          {readyScenario.difficulties
            .slice()
            .sort((left, right) => left.order - right.order)
            .map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={running || !isStygianTargetDifficultyCompatible(target, item.order)}
                aria-pressed={difficultyId === item.id}
                onClick={() => {
                  setDifficultyId(item.id);
                  invalidateResult();
                }}
              >
                <small>{isEnglish ? `Tier ${item.order}` : `第 ${item.order} 档`}</small>
                <strong>{difficultyDisplayName(item, language)}</strong>
              </button>
            ))}
        </div>
        <div
          className="gta-stygian-targets"
          role="group"
          aria-label={isEnglish ? 'Choose reward goal' : '选择奖励目标'}
        >
          {REWARD_TARGETS.map((value) => (
            <button
              key={value}
              type="button"
              disabled={running}
              aria-pressed={target === value}
              onClick={() => {
                setTarget(value);
                setDifficultyId((current) =>
                  clampDifficultyForStygianTarget(value, current, readyScenario.difficulties)
                );
                invalidateResult();
              }}
            >
              {rewardTargetLabel(value, language)}
            </button>
          ))}
        </div>
        <p className="gta-stygian-policy-note">
          {isEnglish
            ? 'In-app target tiers are planning preferences, not official reward unlock requirements. Published versioned rules take priority.'
            : '应用内目标档位，不代表官方奖励解锁条件；正式场景阈值发布后将优先使用其版本化规则。'}
        </p>
        <div className="gta-stygian-modifiers">
          <strong>{isEnglish ? 'Selected difficulty modifiers' : '所选难度修正'}</strong>
          {difficulty && difficulty.modifiers.length > 0 ? (
            <ul>
              {difficultyModifierLabels(difficulty, language).map((label, index) => (
                <li key={difficulty.modifiers[index]?.id ?? label}>{label}</li>
              ))}
            </ul>
          ) : (
            <span>
              {isEnglish
                ? 'No timer, energy, or bonus modifiers are listed.'
                : '资料未标注时间、能量或额外增益。'}
            </span>
          )}
        </div>
      </section>

      <div className="gta-stygian-reuse" role="status">
        <strong>{isEnglish ? 'Character reuse rule' : '三队角色规则'}</strong>
        <span>{reuseRuleSummary(readyScenario.crossPartyReusePolicy, language)}</span>
      </div>

      <div
        className="gta-stygian-phases"
        aria-label={isEnglish ? 'Bosses in all three phases' : '三个阶段首领'}
      >
        {readyScenario.phases
          .slice()
          .sort((left, right) => left.phase - right.phase)
          .map((phase) => {
            const mechanics = stygianMechanicLabels(phase, language);
            return (
              <article key={phase.phase}>
                <span>{isEnglish ? `Phase ${phase.phase}` : `第 ${phase.phase} 阶段`}</span>
                <h4>{stygianBossDisplayName(phase.boss, language)}</h4>
                <p>
                  {isEnglish
                    ? `Level ${phase.boss.level} · ${phase.boss.count} ${phase.boss.count === 1 ? 'boss' : 'bosses'}`
                    : `等级 ${phase.boss.level} · ${phase.boss.count} 名首领`}
                </p>
                <strong>{isEnglish ? 'Mechanics and modifiers' : '机制与修正'}</strong>
                {mechanics.length > 0 ? (
                  <ul>
                    {mechanics.map((text) => (
                      <li key={text}>{text}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="is-unknown">
                    {isEnglish ? 'No additional mechanics are listed.' : '资料未标注额外机制。'}
                  </p>
                )}
              </article>
            );
          })}
      </div>

      <section className="gta-stygian-controls" aria-labelledby="stygian-control-title">
        <div className="gta-stygian-control-heading">
          <div>
            <span className="gta-page-kicker">{isEnglish ? 'Your choices' : '你的取舍'}</span>
            <h4 id="stygian-control-title">
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
          className="gta-stygian-preferences"
          role="group"
          aria-label={isEnglish ? 'Team preferences' : '配队偏好'}
        >
          <Preference
            label={isEnglish ? 'Simple rotations' : '操作简单'}
            active={preferences.comfort === 'high'}
            disabled={running}
            onClick={() => togglePreference('comfort')}
          />
          <Preference
            label={isEnglish ? 'Prioritize survival' : '生存优先'}
            active={preferences.survival === 'high'}
            disabled={running}
            onClick={() => togglePreference('survival')}
          />
          <Preference
            label={isEnglish ? 'Lower investment' : '低练度'}
            active={preferences.lowInvestment === 'high'}
            disabled={running}
            onClick={() => togglePreference('lowInvestment')}
          />
          <Preference
            label={isEnglish ? 'Keep current builds' : '不换装备'}
            active={preferences.noBuildChange}
            disabled={running}
            onClick={() => togglePreference('noBuildChange')}
          />
        </div>
        <div className="gta-stygian-roster-toolbar">
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
              ? `${lockedCharacterIds.length} locked · ${excludedCharacterIds.length} excluded`
              : `已锁定 ${lockedCharacterIds.length} · 已排除 ${excludedCharacterIds.length}`}
          </span>
        </div>
        {lockLimitExceeded && (
          <p className="gta-stygian-inline-error" role="alert">
            {isEnglish
              ? 'Three teams have 12 slots in total. Unlock characters before generating.'
              : '三队总共只有 12 个位置，请先减少锁定角色再生成方案。'}
          </p>
        )}
        <div
          className="gta-stygian-roster"
          aria-label={isEnglish ? 'Character choices' : '角色干预'}
        >
          {characters.map((character) => (
            <CharacterChoice
              key={character.id}
              character={character}
              state={interventions[String(character.id)] ?? 'neutral'}
              disabled={running}
              locale={language}
              onClick={() => cycleCharacter(String(character.id))}
            />
          ))}
        </div>
        <div className="gta-stygian-runbar">
          <GtaButton
            onClick={() => void generatePlan()}
            disabled={running || !difficulty || scenarioReadOnly || lockLimitExceeded}
          >
            {running
              ? isEnglish
                ? 'Planning three teams…'
                : '正在规划三队…'
              : isEnglish
                ? 'Generate three-phase plan'
                : '生成三阶段方案'}
          </GtaButton>
          <GtaButton tone="ghost" onClick={cancelPlan} disabled={!running}>
            {isEnglish ? 'Cancel generation' : '取消生成'}
          </GtaButton>
        </div>
      </section>

      {(running || activeStep) && (
        <ol
          className="gta-stygian-progress"
          aria-label={isEnglish ? 'Team planning progress' : '配队进度'}
          aria-live="polite"
        >
          {PROGRESS_STEPS.map((step, index) => {
            const current = activeStep ? PROGRESS_STEPS.indexOf(activeStep) : -1;
            const done = Boolean(result) || index < current;
            return (
              <li key={step} className={done ? 'is-done' : index === current ? 'is-active' : ''}>
                <span aria-hidden="true">{done ? '✓' : index + 1}</span>
                {progressStepLabel(step, language)}
              </li>
            );
          })}
        </ol>
      )}

      {loadError && (
        <p className="gta-stygian-inline-error" role="alert">
          {isEnglish
            ? 'The three-phase plan could not be generated. Local character and challenge data were not changed.'
            : '生成三阶段方案时发生错误；本地角色与挑战资料没有被修改。'}
        </p>
      )}
      {result && (
        <StygianResult
          result={result}
          profile={profile}
          difficulties={readyScenario.difficulties}
          locale={language}
          onLowerDifficulty={(id) => {
            setDifficultyId(id);
            invalidateResult();
          }}
        />
      )}
    </section>
  );
}

function Preference({
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

function CharacterChoice({
  character,
  state,
  disabled,
  locale,
  onClick
}: {
  character: CharacterProfile;
  state: StygianInterventionState;
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
      className={`gta-stygian-character is-${state}`}
      aria-label={
        isEnglish
          ? `${character.name}, current state: ${stateLabel}; press to change`
          : `${character.name}，当前：${stateLabel}；按下切换`
      }
      aria-pressed={state === 'locked'}
      disabled={disabled}
      onClick={onClick}
    >
      <span aria-hidden="true">{state === 'locked' ? '◆' : state === 'excluded' ? '×' : '·'}</span>
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

function StygianResult({
  result,
  profile,
  difficulties,
  locale,
  onLowerDifficulty
}: {
  result: StygianAdvisorResult;
  profile: PersistedProfile;
  difficulties: StygianScenario['difficulties'];
  locale: PresentationLocale;
  onLowerDifficulty: (id: string) => void;
}) {
  const isEnglish = locale === 'en';
  if (result.status === 'blocked') {
    const budget = result.issues.some(({ code }) => code === 'SEARCH_BUDGET_EXCEEDED');
    return (
      <section className="gta-stygian-result is-blocked" aria-labelledby="stygian-blocked-title">
        <h4 id="stygian-blocked-title">
          {isEnglish
            ? 'Three rule-compliant teams cannot be built yet'
            : '暂时无法组成符合规则的三队'}
        </h4>
        <ul>
          {result.issues.map((item, index) => (
            <li key={`${item.code}-${index}`}>
              {isEnglish
                ? `Planning constraint ${index + 1} is not satisfied by the current choices.`
                : item.message}
            </li>
          ))}
        </ul>
        <p>
          {isEnglish
            ? budget
              ? 'The search limit was reached; this does not prove the roster has no solution.'
              : 'Reduce locked or excluded characters, or choose a more suitable goal.'
            : budget
              ? '搜索到达本次上限，不代表当前角色一定无解。'
              : '请减少锁定或排除角色，或改选更适合的目标。'}
        </p>
      </section>
    );
  }
  const byId = new Map(profile.characters.map((character) => [String(character.id), character]));
  const selectedCharacterIds = result.plan.phases.flatMap((phase) => phase.team.characterIds);
  const localizedDetails = (items: string[]) =>
    items.flatMap((item) => {
      const localized = localizedPlanText(item, locale);
      return localized ? [localized] : [];
    });
  return (
    <section className="gta-stygian-result" aria-labelledby="stygian-result-title">
      <header>
        <div>
          <span className="gta-page-kicker">{isEnglish ? 'Three-phase plan' : '三阶段方案'}</span>
          <h4 id="stygian-result-title">
            {isEnglish ? 'Three teams allocated under current rules' : '三队已按当期规则分配'}
          </h4>
        </div>
        <span>
          {result.source === 'smart-service'
            ? isEnglish
              ? 'Smart service'
              : '智能服务'
            : isEnglish
              ? 'Local rules'
              : '本地规则'}
        </span>
      </header>
      <p>{isEnglish ? result.narrative.summary['en-US'] : result.narrative.summary['zh-CN']}</p>
      {result.difficultyAssessment.recommendation !== 'proceed' && (
        <div className="gta-stygian-honesty" role="status">
          <strong>
            {result.difficultyAssessment.recommendation === 'lower-difficulty'
              ? result.difficultyAssessment.suggestedDifficultyId
                ? isEnglish
                  ? 'Evidence is limited; try a lower difficulty first'
                  : '资料或练度证据不足，建议先降档'
                : isEnglish
                  ? 'Evidence is limited; lower the reward goal'
                  : '资料或练度证据不足，建议降低奖励目标'
              : isEnglish
                ? 'A cautious attempt is reasonable, but success cannot be predicted'
                : '可谨慎尝试，但不能判定能否通过'}
          </strong>
          {(localizedDetails(result.difficultyAssessment.evidence).length > 0
            ? localizedDetails(result.difficultyAssessment.evidence)
            : [
                isEnglish
                  ? 'Saved difficulty evidence is unavailable in English.'
                  : '没有保存可显示的难度判断依据。'
              ]
          ).map((text) => (
            <p key={text}>{text}</p>
          ))}
          {result.difficultyAssessment.suggestedDifficultyId && (
            <GtaButton
              tone="ghost"
              onClick={() => onLowerDifficulty(result.difficultyAssessment.suggestedDifficultyId!)}
            >
              {difficultySuggestionLabel(
                difficulties,
                result.difficultyAssessment.suggestedDifficultyId,
                locale
              )}
            </GtaButton>
          )}
        </div>
      )}
      <div className="gta-stygian-result-phases">
        {result.plan.phases
          .slice()
          .sort((left, right) => left.phase - right.phase)
          .map((phase) => {
            const guidance = result.phaseGuidance.find((item) => item.phase === phase.phase);
            const rotationNotes = localizedDetails(phase.team.rotationNotes);
            const mechanismBasis = localizedDetails(guidance?.mechanismBasis ?? []);
            const risks = localizedDetails(guidance?.risks ?? []);
            return (
              <article key={phase.phase}>
                <span>{isEnglish ? `Phase ${phase.phase}` : `第 ${phase.phase} 阶段`}</span>
                <h5>
                  {narrativeTargetBody(
                    result.narrative,
                    `stygian-phase:${phase.phase}`,
                    locale
                  )}
                </h5>
                <div className="gta-stygian-result-roster">
                  {phase.team.characterIds.map((id) => {
                    const character = byId.get(id);
                    return (
                      <span key={id} data-stygian-result-character-id={id}>
                        <strong>
                          {character
                            ? localizedProfileName(character.name, id, selectedCharacterIds, locale)
                            : isEnglish
                              ? 'Unknown character'
                              : '未知角色'}
                        </strong>
                        <small>
                          {character
                            ? isEnglish
                              ? `${characterElementLabel(character.element, locale)} · Level ${character.level ?? 'unknown'}`
                              : `${characterElementLabel(character.element, locale)}元素 · 等级 ${character.level ?? '未知'}`
                            : isEnglish
                              ? 'Character data unavailable'
                              : '角色资料缺失'}
                        </small>
                      </span>
                    );
                  })}
                </div>
                <section>
                  <strong>{isEnglish ? 'Opening rotation' : '开局循环'}</strong>
                  {(rotationNotes.length > 0
                    ? rotationNotes
                    : [
                        isEnglish
                          ? 'Saved rotation details are unavailable in English.'
                          : '没有保存可显示的循环细节。'
                      ]
                  ).map((text) => (
                    <p key={text}>{text}</p>
                  ))}
                </section>
                <section>
                  <strong>{isEnglish ? 'Mechanic basis' : '机制依据'}</strong>
                  {(mechanismBasis.length > 0
                    ? mechanismBasis
                    : [
                        isEnglish
                          ? 'Saved mechanic details are unavailable in English.'
                          : '没有保存可显示的机制依据。'
                      ]
                  ).map((text) => (
                    <p key={text}>{text}</p>
                  ))}
                </section>
                <section>
                  <strong>{isEnglish ? 'Watch for' : '需要留意'}</strong>
                  {(risks.length > 0
                    ? risks
                    : [
                        isEnglish
                          ? 'Saved risk details are unavailable in English.'
                          : '没有保存可显示的风险细节。'
                      ]
                  ).map((text) => (
                    <p key={text}>{text}</p>
                  ))}
                </section>
              </article>
            );
          })}
      </div>
      {(result.warnings.length > 0 || result.assumptions.length > 0) && (
        <footer>
          {result.warnings.length > 0 && (
            <p>
              <strong>{isEnglish ? 'Watch for: ' : '需要留意：'}</strong>
              {localizedDetails(result.warnings).join(isEnglish ? '; ' : '；') ||
                (isEnglish ? 'Saved warnings are unavailable in English.' : '暂无额外提醒')}
            </p>
          )}
          {result.assumptions.length > 0 && (
            <p>
              <strong>{isEnglish ? 'This recommendation assumes: ' : '本次建议基于：'}</strong>
              {localizedDetails(result.assumptions).join(isEnglish ? '; ' : '；') ||
                (isEnglish ? 'Saved assumptions are unavailable in English.' : '暂无额外前提')}
            </p>
          )}
        </footer>
      )}
    </section>
  );
}
