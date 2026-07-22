import { useEffect, useMemo, useRef, useState } from 'react';

import type { CharacterProfile, PersistedProfile } from '../../../shared/domain';
import type {
  AbyssAdvisorProgressStep,
  AbyssAdvisorResult,
  AbyssScenarioView
} from '../../../shared/abyss-advisor';
import type { EnemyInstance, EnemyWave, PlayerPreferences } from '../../../shared/scenario-v2';
import { api } from '../../ipc';
import { GtaButton } from '../../components/ui/GtaButton';
import {
  characterElementLabel,
  cycleCharacterIntervention,
  enemyDisplayName,
  mechanicLabels,
  progressStepLabel,
  type CharacterInterventionState
} from './abyss-presentation';

interface AbyssWorkspaceProps {
  uid: string;
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

export function AbyssWorkspace({ uid }: AbyssWorkspaceProps) {
  const [scenarioView, setScenarioView] = useState<AbyssScenarioView | null>(null);
  const [profile, setProfile] = useState<PersistedProfile | null>(null);
  const [loadError, setLoadError] = useState('');
  const [floorNumber, setFloorNumber] = useState<number | null>(null);
  const [chamberNumber, setChamberNumber] = useState<number | 'all'>('all');
  const [preferences, setPreferences] = useState<PlayerPreferences>(DEFAULT_PREFERENCES);
  const [interventions, setInterventions] = useState<Record<string, CharacterInterventionState>>(
    {}
  );
  const [search, setSearch] = useState('');
  const [result, setResult] = useState<AbyssAdvisorResult | null>(null);
  const [activeStep, setActiveStep] = useState<AbyssAdvisorProgressStep | null>(null);
  const [running, setRunning] = useState(false);
  const requestSequence = useRef(0);
  const activeCorrelation = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    requestSequence.current += 1;
    activeCorrelation.current = null;
    void api.abyssAdvisor.cancel();
    setScenarioView(null);
    setProfile(null);
    setLoadError('');
    setFloorNumber(null);
    setChamberNumber('all');
    setInterventions({});
    setResult(null);
    setActiveStep(null);
    setRunning(false);
    void Promise.all([api.abyssAdvisor.getScenario(), api.profile.get({ uid })])
      .then(([nextScenario, nextProfile]) => {
        if (!active) return;
        setScenarioView(nextScenario);
        setProfile(nextProfile);
        if (nextScenario.status === 'ready') {
          setFloorNumber(nextScenario.scenario.floors[0]?.floor ?? null);
        }
      })
      .catch(() => {
        if (active) setLoadError('读取深境螺旋资料失败，请稍后重试。');
      });
    return () => {
      active = false;
      requestSequence.current += 1;
      activeCorrelation.current = null;
      void api.abyssAdvisor.cancel();
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

  function invalidatePlan() {
    requestSequence.current += 1;
    activeCorrelation.current = null;
    setResult(null);
    setActiveStep(null);
    if (running) {
      setRunning(false);
      void api.abyssAdvisor.cancel();
    }
  }

  function togglePreference(key: 'comfort' | 'survival' | 'lowInvestment' | 'noBuildChange') {
    setPreferences((previous) =>
      key === 'noBuildChange'
        ? { ...previous, noBuildChange: !previous.noBuildChange }
        : { ...previous, [key]: previous[key] === 'high' ? 'off' : 'high' }
    );
    invalidatePlan();
  }

  function cycleCharacter(id: string) {
    setInterventions((previous) => ({
      ...previous,
      [id]: cycleCharacterIntervention(previous[id] ?? 'neutral')
    }));
    invalidatePlan();
  }

  async function generatePlan() {
    if (!scenario || !floor || tooManyLocks || scenarioReadOnly) return;
    const requestId = requestSequence.current + 1;
    const correlationId = `abyss-${Date.now()}-${requestId}`;
    requestSequence.current = requestId;
    activeCorrelation.current = correlationId;
    setRunning(true);
    setResult(null);
    setActiveStep('reading-roster');
    try {
      const next = await api.abyssAdvisor.recommend({
        correlationId,
        uid,
        scenarioId: scenario.id,
        dataVersion: scenario.meta.dataVersion,
        floor: floor.floor,
        ...(chamberNumber === 'all' ? {} : { chamber: chamberNumber }),
        preferences,
        lockedCharacterIds,
        excludedCharacterIds
      });
      if (requestSequence.current === requestId) setResult(next);
    } catch {
      if (requestSequence.current === requestId) {
        setLoadError('生成方案时发生错误；角色与挑战资料没有被修改。');
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
    activeCorrelation.current = null;
    setRunning(false);
    setActiveStep(null);
    void api.abyssAdvisor.cancel();
  }

  if (loadError) {
    return (
      <div className="gta-abyss-unavailable" role="alert">
        {loadError}
      </div>
    );
  }
  if (!scenarioView || !profile) {
    return <div className="gta-abyss-unavailable">正在读取角色与挑战资料…</div>;
  }
  if (scenarioView.status === 'unavailable') {
    return (
      <section className="gta-abyss-unavailable" aria-labelledby="abyss-unavailable-title">
        <span className="gta-page-kicker">深境螺旋</span>
        <h3 id="abyss-unavailable-title">本期挑战资料暂不可用</h3>
        <p>{scenarioView.message} 你仍可查看角色、历史方案，或在下方打开自定义演练。</p>
      </section>
    );
  }
  const readyScenario = scenarioView.scenario;

  return (
    <section className="gta-abyss-workspace" aria-labelledby="abyss-workspace-title">
      <header className="gta-abyss-heading">
        <div>
          <span className="gta-page-kicker">双队联合规划</span>
          <h3 id="abyss-workspace-title">深境螺旋战线</h3>
          <p>先确认上下半敌情，再锁定或排除角色。两队会一次生成并检查抢人冲突。</p>
        </div>
        <div className="gta-abyss-data-stamp">
          <span>资料版本</span>
          <strong>
            {scenarioView.trust === 'development-sample'
              ? readyScenario.meta.dataVersion.replace(/^development\./, '演练 · ')
              : readyScenario.meta.dataVersion}
          </strong>
        </div>
      </header>

      {scenarioView.trust === 'development-sample' && (
        <div className="gta-abyss-sample-banner" role="status">
          <strong>演练资料，不代表本期</strong>
          <span>以下敌人与规则只用于验证交互和约束；不会冒充正式服当前周期。</span>
        </div>
      )}
      {scenarioReadOnly && (
        <div className="gta-abyss-sample-banner" role="status">
          <strong>资料已过期，仅供查看</strong>
          <span>正式数据刷新失败或已失效；为避免误导，暂时不能据此生成新方案。</span>
        </div>
      )}

      <nav className="gta-abyss-targets" aria-label="选择深境螺旋目标">
        <div className="gta-abyss-floor-tabs" role="group" aria-label="选择楼层">
          {readyScenario.floors.map(({ floor: number }) => (
            <button
              key={number}
              type="button"
              disabled={running}
              aria-pressed={floorNumber === number}
              onClick={() => {
                setFloorNumber(number);
                setChamberNumber('all');
                invalidatePlan();
              }}
            >
              {number} 层
            </button>
          ))}
        </div>
        <label>
          <span>目标房间</span>
          <select
            disabled={running}
            value={chamberNumber}
            onChange={(event) => {
              setChamberNumber(event.target.value === 'all' ? 'all' : Number(event.target.value));
              invalidatePlan();
            }}
          >
            <option value="all">全部房间 · 固定双队</option>
            {floor?.chambers.map(({ chamber }) => (
              <option key={chamber} value={chamber}>
                第 {chamber} 间
              </option>
            ))}
          </select>
        </label>
      </nav>

      <div className="gta-abyss-blessing">
        <span>{scenarioView.trust === 'development-sample' ? '演练增益' : '本期祝福'}</span>
        <p>{readyScenario.blessing.description}</p>
      </div>

      <div className="gta-abyss-halves" aria-label="上下半敌情">
        <AbyssHalf title="上半敌情" half="first" chambers={selectedChambers} />
        <AbyssHalf title="下半敌情" half="second" chambers={selectedChambers} />
      </div>

      <section className="gta-abyss-controls" aria-labelledby="abyss-preference-title">
        <div className="gta-abyss-control-heading">
          <div>
            <span className="gta-page-kicker">你的取舍</span>
            <h4 id="abyss-preference-title">偏好与角色干预</h4>
          </div>
          <p>角色按钮依次切换：未设置 → 锁定 → 排除。</p>
        </div>
        <div className="gta-abyss-preferences" role="group" aria-label="配队偏好">
          <PreferenceChip
            label="操作简单"
            disabled={running}
            active={preferences.comfort === 'high'}
            onClick={() => togglePreference('comfort')}
          />
          <PreferenceChip
            label="生存优先"
            disabled={running}
            active={preferences.survival === 'high'}
            onClick={() => togglePreference('survival')}
          />
          <PreferenceChip
            label="低练度"
            disabled={running}
            active={preferences.lowInvestment === 'high'}
            onClick={() => togglePreference('lowInvestment')}
          />
          <PreferenceChip
            label="不换装备"
            disabled={running}
            active={preferences.noBuildChange}
            onClick={() => togglePreference('noBuildChange')}
          />
        </div>
        <div className="gta-abyss-roster-toolbar">
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
            已锁定 {lockedCharacterIds.length} / 8 · 已排除 {excludedCharacterIds.length}
          </span>
        </div>
        {tooManyLocks && (
          <p className="gta-abyss-inline-error" role="alert">
            最多锁定 8 名角色；请先取消至少 {lockedCharacterIds.length - 8} 名。
          </p>
        )}
        <div className="gta-abyss-roster" aria-label="角色干预">
          {characters.map((character) => (
            <CharacterInterventionButton
              key={character.id}
              character={character}
              disabled={running}
              state={interventions[String(character.id)] ?? 'neutral'}
              onClick={() => cycleCharacter(String(character.id))}
            />
          ))}
        </div>
        <div className="gta-abyss-runbar">
          <GtaButton
            onClick={() => void generatePlan()}
            disabled={running || tooManyLocks || selectedChambers.length === 0 || scenarioReadOnly}
          >
            {running ? '正在生成双队…' : '生成上下半方案'}
          </GtaButton>
          {running && (
            <GtaButton tone="ghost" onClick={cancelPlan}>
              取消生成
            </GtaButton>
          )}
          {result && <span>调整后重新生成完整双队，才能继续检查跨队冲突。</span>}
        </div>
      </section>

      {(running || activeStep) && (
        <ol className="gta-abyss-progress" aria-label="配队进度" aria-live="polite">
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
                {progressStepLabel(step)}
              </li>
            );
          })}
        </ol>
      )}

      {result && <AbyssResult result={result} profile={profile} />}
    </section>
  );
}

function AbyssHalf({
  title,
  half,
  chambers
}: {
  title: string;
  half: 'first' | 'second';
  chambers: Array<{
    chamber: number;
    firstHalf: { waves: EnemyWave[] };
    secondHalf: { waves: EnemyWave[] };
    targetSeconds?: number;
  }>;
}) {
  return (
    <section className={`gta-abyss-half gta-abyss-half--${half}`}>
      <h4>{title}</h4>
      {chambers.map((chamber) => (
        <div key={chamber.chamber} className="gta-abyss-chamber">
          <div className="gta-abyss-chamber-title">
            <strong>第 {chamber.chamber} 间</strong>
            {chamber.targetSeconds && <span>目标总时长 {chamber.targetSeconds} 秒</span>}
          </div>
          {(half === 'first' ? chamber.firstHalf.waves : chamber.secondHalf.waves).map(
            (wave, index) => (
              <div key={wave.id} className="gta-abyss-wave">
                <span className="gta-abyss-wave-index">第 {index + 1} 波</span>
                {wave.enemies.map((enemy) => (
                  <EnemyRow key={enemy.enemy.id} enemy={enemy} />
                ))}
              </div>
            )
          )}
        </div>
      ))}
    </section>
  );
}

function EnemyRow({ enemy }: { enemy: EnemyInstance }) {
  const labels = mechanicLabels(enemy.mechanics);
  return (
    <article className="gta-abyss-enemy">
      <div>
        <strong>
          {enemyDisplayName(enemy)} <small>×{enemy.count}</small>
        </strong>
        <span>等级 {enemy.level}</span>
      </div>
      {labels.length > 0 ? (
        <ul>
          {labels.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      ) : (
        <p>资料未标注特殊机制</p>
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
  onClick
}: {
  character: CharacterProfile;
  state: CharacterInterventionState;
  disabled: boolean;
  onClick: () => void;
}) {
  const stateLabel = state === 'locked' ? '锁定' : state === 'excluded' ? '排除' : '未设置';
  return (
    <button
      type="button"
      className={`gta-abyss-character is-${state}`}
      aria-label={`${character.name}，当前：${stateLabel}；按下切换`}
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
          等级 {character.level ?? '未知'} · {characterElementLabel(character.element)}元素
        </small>
      </span>
      <em>{stateLabel}</em>
    </button>
  );
}

function AbyssResult({
  result,
  profile
}: {
  result: AbyssAdvisorResult;
  profile: PersistedProfile;
}) {
  if (result.status === 'blocked') {
    return (
      <section
        className="gta-abyss-result gta-abyss-result--blocked"
        aria-labelledby="abyss-blocked-title"
      >
        <h4 id="abyss-blocked-title">暂时无法组成两支完整队伍</h4>
        <ul>
          {result.issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>{issue.message}</li>
          ))}
        </ul>
        <p>请减少锁定或排除角色，或补充角色资料后再试。</p>
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
          <span className="gta-page-kicker">固定双队方案</span>
          <h4 id="abyss-result-title">上下半零重复</h4>
        </div>
        <div className={`gta-abyss-source is-${result.source}`}>
          {result.source === 'smart-service' ? '智能服务' : '本地规则'}
        </div>
      </header>
      <div className="gta-abyss-result-teams">
        <ResultTeam
          title="上半队伍"
          ids={result.plan.firstHalfTeam.characterIds}
          purpose={result.plan.firstHalfTeam.purpose}
          rotationNotes={result.plan.firstHalfTeam.rotationNotes}
          characters={characterById}
        />
        <ResultTeam
          title="下半队伍"
          ids={result.plan.secondHalfTeam.characterIds}
          purpose={result.plan.secondHalfTeam.purpose}
          rotationNotes={result.plan.secondHalfTeam.rotationNotes}
          characters={characterById}
        />
      </div>
      <div className="gta-abyss-tactics">
        {result.plan.chambers.map((chamber) => (
          <article key={`${chamber.floor}-${chamber.chamber}`}>
            <h5>
              {chamber.floor} 层 · 第 {chamber.chamber} 间
            </h5>
            <div>
              <strong>上半怎么打</strong>
              {chamber.firstHalf.tactics.map((text) => (
                <p key={text}>{text}</p>
              ))}
              <small>超时风险：{chamber.firstHalf.risks.join('；') || '暂无额外提示'}</small>
              <small>
                替换建议：
                {chamber.firstHalf.substitutionNotes.join('；') || '调整角色后重新生成完整双队'}
              </small>
            </div>
            <div>
              <strong>下半怎么打</strong>
              {chamber.secondHalf.tactics.map((text) => (
                <p key={text}>{text}</p>
              ))}
              <small>超时风险：{chamber.secondHalf.risks.join('；') || '暂无额外提示'}</small>
              <small>
                替换建议：
                {chamber.secondHalf.substitutionNotes.join('；') || '调整角色后重新生成完整双队'}
              </small>
            </div>
          </article>
        ))}
      </div>
      <div className="gta-abyss-result-notes">
        <div>
          <strong>建议把握</strong>
          <span>
            {result.plan.confidence === 'high'
              ? '较高'
              : result.plan.confidence === 'medium'
                ? '中等'
                : '较低'}
          </span>
        </div>
        {result.warnings.length > 0 && (
          <div>
            <strong>需要留意</strong>
            <span>{result.warnings.join('；')}</span>
          </div>
        )}
        {result.assumptions.length > 0 && (
          <div>
            <strong>本次建议基于</strong>
            <span>{result.assumptions.join('；')}</span>
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
  characters
}: {
  title: string;
  ids: string[];
  purpose: string;
  rotationNotes: string[];
  characters: Map<string, CharacterProfile>;
}) {
  return (
    <section>
      <h5>{title}</h5>
      <p>{purpose}</p>
      {rotationNotes.length > 0 && (
        <p className="gta-abyss-rotation">循环：{rotationNotes.join('；')}</p>
      )}
      <div className="gta-abyss-result-roster">
        {ids.map((id) => {
          const character = characters.get(id);
          return (
            <span key={id} data-result-character-id={id}>
              <strong>{character?.name ?? '未知角色'}</strong>
              <small>
                {character
                  ? `${characterElementLabel(character.element)}元素 · 等级 ${character.level ?? '未知'}`
                  : `角色编号 ${id}`}
              </small>
            </span>
          );
        })}
      </div>
    </section>
  );
}
