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
import { GtaButton } from '../../components/ui/GtaButton';
import { api } from '../../ipc';
import { characterElementLabel } from './abyss-presentation';
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
import { prepareStygianRerun } from './history-rerun-prefill';

interface StygianWorkspaceProps {
  uid: string;
  historyRerun?: Extract<HistoryRerunIntent, { mode: 'stygian-onslaught' }>;
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

export function StygianWorkspace({ uid, historyRerun, onBack }: StygianWorkspaceProps) {
  const [scenarioView, setScenarioView] = useState<StygianScenarioView | null>(null);
  const [profile, setProfile] = useState<PersistedProfile | null>(null);
  const [loadError, setLoadError] = useState('');
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
  const appliedHistoryId = useRef<string | null>(null);
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
          if (
            historyRerun &&
            appliedHistoryId.current !== historyRerun.historyId &&
            nextProfile
          ) {
            appliedHistoryId.current = historyRerun.historyId;
            const prepared = prepareStygianRerun(
              historyRerun,
              uid,
              ordered.map(({ id }) => id),
              nextProfile.characters.map(({ id }) => String(id))
            );
            if (prepared.status === 'blocked') {
              setHistoryNotice(
                '这份旧方案属于另一个 UID；已保留旧方案查看，但没有带入当前账号。'
              );
            } else {
              setDifficultyId(prepared.difficultyId || defaultDifficulty);
              setTarget(prepared.target);
              setPreferences(prepared.preferences);
              setInterventions({
                ...Object.fromEntries(prepared.lockedCharacterIds.map((id) => [id, 'locked'])),
                ...Object.fromEntries(prepared.excludedCharacterIds.map((id) => [id, 'excluded']))
              });
              setHistoryNotice(
                prepared.status === 'adjusted'
                  ? `已带入旧方案的可用选择；${
                      prepared.targetUnavailable ? '原难度已不在当前资料中；' : ''
                    }${
                      prepared.removedCharacterCount > 0
                        ? `${prepared.removedCharacterCount} 名已不在当前角色资料中的角色未带入；`
                        : ''
                    }请检查后再点击生成，不会自动调用智能服务。`
                  : '已带入旧方案的难度、目标、偏好与角色选择。请检查后再点击生成，不会自动调用智能服务。'
              );
            }
          }
        }
      })
      .catch(() => {
        if (active) setLoadError('读取幽境危战资料失败，请稍后重试。');
      });
    return () => {
      active = false;
      sequence.current += 1;
      const correlationId = activeCorrelation.current;
      activeCorrelation.current = null;
      if (correlationId) void api.stygianAdvisor.cancel({ correlationId });
    };
  }, [historyRerun, uid]);

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
        difficultyId: difficulty.id,
        target,
        preferences,
        lockedCharacterIds,
        excludedCharacterIds
      });
      if (sequence.current === requestId) setResult(next);
    } catch {
      if (sequence.current === requestId) {
        setLoadError('生成三阶段方案时发生错误；本地角色与挑战资料没有被修改。');
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
        {loadError}
      </div>
    );
  }
  if (!scenarioView || !profile) {
    return <div className="gta-stygian-unavailable">正在读取角色与挑战资料…</div>;
  }
  if (scenarioView.status === 'unavailable') {
    return (
      <section className="gta-stygian-unavailable" aria-labelledby="stygian-unavailable-title">
        <GtaButton tone="ghost" onClick={onBack}>
          返回挑战入口
        </GtaButton>
        <span className="gta-page-kicker">幽境危战</span>
        <h3 id="stygian-unavailable-title">本期挑战资料暂不可用</h3>
        <p>{scenarioView.message} 你仍可查看角色与历史方案。</p>
      </section>
    );
  }
  const readyScenario = scenarioView.scenario;

  return (
    <section className="gta-stygian-workspace" aria-labelledby="stygian-workspace-title">
      <header className="gta-stygian-heading">
        <div>
          <GtaButton tone="ghost" onClick={onBack}>
            返回挑战入口
          </GtaButton>
          <span className="gta-page-kicker">三阶段联合规划</span>
          <h3 id="stygian-workspace-title">幽境危战作战台</h3>
          <p>先选择目标难度和奖励，再按当期复用规则一次分配三队。</p>
        </div>
        <div className="gta-stygian-data-stamp">
          <span>资料版本</span>
          <strong>{scenarioVersionLabel(scenarioView)}</strong>
        </div>
      </header>

      {scenarioView.trust === 'development-sample' && (
        <div className="gta-stygian-banner" role="status">
          <strong>演练资料，不代表本期</strong>
          <span>三名首领、六档难度与规则均为交互演示，不是正式服当前内容。</span>
        </div>
      )}
      {historyNotice && (
        <div className="gta-stygian-banner is-history-prefill" role="status">
          <strong>旧方案已准备</strong>
          <span>{historyNotice}</span>
        </div>
      )}
      {scenarioReadOnly && (
        <div className="gta-stygian-banner" role="status">
          <strong>资料已过期，仅供查看</strong>
          <span>为避免误导，暂时不能据此生成本期方案。</span>
        </div>
      )}
      {scenarioView.trust === 'production' && scenarioView.refreshWarning && !scenarioReadOnly && (
        <div className="gta-stygian-banner is-refresh-warning" role="status">
          <strong>正在使用最近一次已确认资料</strong>
          <span>{scenarioView.refreshWarning} 请留意资料版本。</span>
        </div>
      )}

      <section className="gta-stygian-objective" aria-labelledby="stygian-objective-title">
        <div>
          <span className="gta-page-kicker">挑战目标</span>
          <h4 id="stygian-objective-title">选择难度与奖励期待</h4>
        </div>
        <div className="gta-stygian-difficulties" role="group" aria-label="选择六档难度">
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
                <small>第 {item.order} 档</small>
                <strong>{difficultyDisplayName(item)}</strong>
              </button>
            ))}
        </div>
        <div className="gta-stygian-targets" role="group" aria-label="选择奖励目标">
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
              {rewardTargetLabel(value)}
            </button>
          ))}
        </div>
        <p className="gta-stygian-policy-note">
          应用内目标档位，不代表官方奖励解锁条件；正式场景阈值发布后将优先使用其版本化规则。
        </p>
        <div className="gta-stygian-modifiers">
          <strong>所选难度修正</strong>
          {difficulty && difficulty.modifiers.length > 0 ? (
            <ul>
              {difficultyModifierLabels(difficulty).map((label, index) => (
                <li key={difficulty.modifiers[index]?.id ?? label}>{label}</li>
              ))}
            </ul>
          ) : (
            <span>资料未标注时间、能量或额外增益。</span>
          )}
        </div>
      </section>

      <div className="gta-stygian-reuse" role="status">
        <strong>三队角色规则</strong>
        <span>{reuseRuleSummary(readyScenario.crossPartyReusePolicy)}</span>
      </div>

      <div className="gta-stygian-phases" aria-label="三个阶段首领">
        {readyScenario.phases
          .slice()
          .sort((left, right) => left.phase - right.phase)
          .map((phase) => {
            const mechanics = stygianMechanicLabels(phase);
            return (
              <article key={phase.phase}>
                <span>第 {phase.phase} 阶段</span>
                <h4>{stygianBossDisplayName(phase.boss)}</h4>
                <p>
                  等级 {phase.boss.level} · {phase.boss.count} 名首领
                </p>
                <strong>机制与修正</strong>
                {mechanics.length > 0 ? (
                  <ul>
                    {mechanics.map((text) => (
                      <li key={text}>{text}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="is-unknown">资料未标注额外机制。</p>
                )}
              </article>
            );
          })}
      </div>

      <section className="gta-stygian-controls" aria-labelledby="stygian-control-title">
        <div className="gta-stygian-control-heading">
          <div>
            <span className="gta-page-kicker">你的取舍</span>
            <h4 id="stygian-control-title">偏好与角色干预</h4>
          </div>
          <p>角色按钮依次切换：未设置 → 锁定 → 排除。</p>
        </div>
        <div className="gta-stygian-preferences" role="group" aria-label="配队偏好">
          <Preference
            label="操作简单"
            active={preferences.comfort === 'high'}
            disabled={running}
            onClick={() => togglePreference('comfort')}
          />
          <Preference
            label="生存优先"
            active={preferences.survival === 'high'}
            disabled={running}
            onClick={() => togglePreference('survival')}
          />
          <Preference
            label="低练度"
            active={preferences.lowInvestment === 'high'}
            disabled={running}
            onClick={() => togglePreference('lowInvestment')}
          />
          <Preference
            label="不换装备"
            active={preferences.noBuildChange}
            disabled={running}
            onClick={() => togglePreference('noBuildChange')}
          />
        </div>
        <div className="gta-stygian-roster-toolbar">
          <label>
            <span className="gta-visually-hidden">搜索可用角色</span>
            <input
              type="search"
              aria-label="搜索可用角色"
              placeholder="搜索可用角色"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <span>
            已锁定 {lockedCharacterIds.length} · 已排除 {excludedCharacterIds.length}
          </span>
        </div>
        {lockLimitExceeded && (
          <p className="gta-stygian-inline-error" role="alert">
            三队总共只有 12 个位置，请先减少锁定角色再生成方案。
          </p>
        )}
        <div className="gta-stygian-roster" aria-label="角色干预">
          {characters.map((character) => (
            <CharacterChoice
              key={character.id}
              character={character}
              state={interventions[String(character.id)] ?? 'neutral'}
              disabled={running}
              onClick={() => cycleCharacter(String(character.id))}
            />
          ))}
        </div>
        <div className="gta-stygian-runbar">
          <GtaButton
            onClick={() => void generatePlan()}
            disabled={running || !difficulty || scenarioReadOnly || lockLimitExceeded}
          >
            {running ? '正在规划三队…' : '生成三阶段方案'}
          </GtaButton>
          <GtaButton tone="ghost" onClick={cancelPlan} disabled={!running}>
            取消生成
          </GtaButton>
        </div>
      </section>

      {(running || activeStep) && (
        <ol className="gta-stygian-progress" aria-label="配队进度" aria-live="polite">
          {PROGRESS_STEPS.map((step, index) => {
            const current = activeStep ? PROGRESS_STEPS.indexOf(activeStep) : -1;
            const done = Boolean(result) || index < current;
            return (
              <li key={step} className={done ? 'is-done' : index === current ? 'is-active' : ''}>
                <span aria-hidden="true">{done ? '✓' : index + 1}</span>
                {progressStepLabel(step)}
              </li>
            );
          })}
        </ol>
      )}

      {loadError && (
        <p className="gta-stygian-inline-error" role="alert">
          {loadError}
        </p>
      )}
      {result && (
        <StygianResult
          result={result}
          profile={profile}
          difficulties={readyScenario.difficulties}
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
  onClick
}: {
  character: CharacterProfile;
  state: StygianInterventionState;
  disabled: boolean;
  onClick: () => void;
}) {
  const stateLabel = state === 'locked' ? '锁定' : state === 'excluded' ? '排除' : '未设置';
  return (
    <button
      type="button"
      className={`gta-stygian-character is-${state}`}
      aria-label={`${character.name}，当前：${stateLabel}；按下切换`}
      aria-pressed={state === 'locked'}
      disabled={disabled}
      onClick={onClick}
    >
      <span aria-hidden="true">{state === 'locked' ? '◆' : state === 'excluded' ? '×' : '·'}</span>
      <span>
        <strong>{character.name}</strong>
        <small>
          等级 {character.level ?? '未知'} · {characterElementLabel(character.element)}元素
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
  onLowerDifficulty
}: {
  result: StygianAdvisorResult;
  profile: PersistedProfile;
  difficulties: StygianScenario['difficulties'];
  onLowerDifficulty: (id: string) => void;
}) {
  if (result.status === 'blocked') {
    const budget = result.issues.some(({ code }) => code === 'SEARCH_BUDGET_EXCEEDED');
    return (
      <section className="gta-stygian-result is-blocked" aria-labelledby="stygian-blocked-title">
        <h4 id="stygian-blocked-title">暂时无法组成符合规则的三队</h4>
        <ul>
          {result.issues.map((item, index) => (
            <li key={`${item.code}-${index}`}>{item.message}</li>
          ))}
        </ul>
        <p>
          {budget
            ? '搜索到达本次上限，不代表当前角色一定无解。'
            : '请减少锁定或排除角色，或改选更适合的目标。'}
        </p>
      </section>
    );
  }
  const byId = new Map(profile.characters.map((character) => [String(character.id), character]));
  return (
    <section className="gta-stygian-result" aria-labelledby="stygian-result-title">
      <header>
        <div>
          <span className="gta-page-kicker">三阶段方案</span>
          <h4 id="stygian-result-title">三队已按当期规则分配</h4>
        </div>
        <span>{result.source === 'smart-service' ? '智能服务' : '本地规则'}</span>
      </header>
      {result.difficultyAssessment.recommendation !== 'proceed' && (
        <div className="gta-stygian-honesty" role="status">
          <strong>
            {result.difficultyAssessment.recommendation === 'lower-difficulty'
              ? result.difficultyAssessment.suggestedDifficultyId
                ? '资料或练度证据不足，建议先降档'
                : '资料或练度证据不足，建议降低奖励目标'
              : '可谨慎尝试，但不能判定能否通过'}
          </strong>
          {result.difficultyAssessment.evidence.map((text) => (
            <p key={text}>{text}</p>
          ))}
          {result.difficultyAssessment.suggestedDifficultyId && (
            <GtaButton
              tone="ghost"
              onClick={() => onLowerDifficulty(result.difficultyAssessment.suggestedDifficultyId!)}
            >
              {difficultySuggestionLabel(
                difficulties,
                result.difficultyAssessment.suggestedDifficultyId
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
            return (
              <article key={phase.phase}>
                <span>第 {phase.phase} 阶段</span>
                <h5>{phase.team.purpose}</h5>
                <div className="gta-stygian-result-roster">
                  {phase.team.characterIds.map((id) => {
                    const character = byId.get(id);
                    return (
                      <span key={id} data-stygian-result-character-id={id}>
                        <strong>{character?.name ?? '未知角色'}</strong>
                        <small>
                          {character
                            ? `${characterElementLabel(character.element)}元素 · 等级 ${character.level ?? '未知'}`
                            : '角色资料缺失'}
                        </small>
                      </span>
                    );
                  })}
                </div>
                <section>
                  <strong>开局循环</strong>
                  {phase.team.rotationNotes.map((text) => (
                    <p key={text}>{text}</p>
                  ))}
                </section>
                <section>
                  <strong>机制依据</strong>
                  {guidance?.mechanismBasis.map((text) => (
                    <p key={text}>{text}</p>
                  ))}
                </section>
                <section>
                  <strong>需要留意</strong>
                  {guidance?.risks.map((text) => (
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
              <strong>需要留意：</strong>
              {result.warnings.join('；')}
            </p>
          )}
          {result.assumptions.length > 0 && (
            <p>
              <strong>本次建议基于：</strong>
              {result.assumptions.join('；')}
            </p>
          )}
        </footer>
      )}
    </section>
  );
}
