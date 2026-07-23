import { useEffect, useMemo, useRef, useState } from 'react';

import type { CharacterProfile, PersistedProfile } from '../../../shared/domain';
import type {
  TheaterAdvisorProgressStep,
  TheaterAdvisorResult,
  TheaterObjective,
  TheaterScenario,
  TheaterScenarioView
} from '../../../shared/theater-advisor';
import type { PlayerPreferences } from '../../../shared/scenario-v2';
import { GtaButton } from '../../components/ui/GtaButton';
import { api } from '../../ipc';
import {
  eligibilityReasonLabel,
  elementLabel,
  objectiveLabel,
  pathChoiceLabel,
  poolSourceLabel,
  progressStepLabel,
  scenarioVersionLabel,
  theaterActPresentation,
  theaterEntityName
} from './theater-presentation';

const PROGRESS: TheaterAdvisorProgressStep[] = [
  'reading-roster',
  'checking-eligibility',
  'planning-cast',
  'budgeting-vigor',
  'writing-route'
];
const OBJECTIVES: TheaterObjective[] = ['eligibility-check', 'safe-clear', 'explore-hard'];

export function TheaterWorkspace({ uid, onBack }: { uid: string; onBack: () => void }) {
  const [view, setView] = useState<TheaterScenarioView | null>(null);
  const [profile, setProfile] = useState<PersistedProfile | null>(null);
  const [loadError, setLoadError] = useState('');
  const [target, setTarget] = useState<TheaterObjective>('safe-clear');
  const [selectedOwned, setSelectedOwned] = useState<string[]>([]);
  const [selectedPools, setSelectedPools] = useState<Record<string, string[]>>({
    opening: [],
    trial: [],
    'special-guest': [],
    support: []
  });
  const [preferences, setPreferences] = useState<PlayerPreferences>({
    comfort: 'medium',
    survival: 'medium',
    lowInvestment: 'low',
    noBuildChange: true
  });
  const [running, setRunning] = useState(false);
  const [activeStep, setActiveStep] = useState<TheaterAdvisorProgressStep | null>(null);
  const [result, setResult] = useState<TheaterAdvisorResult | null>(null);
  const activeCorrelation = useRef<string | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    let active = true;
    void Promise.all([api.theaterAdvisor.getScenario(), api.profile.get({ uid })])
      .then(([nextView, nextProfile]) => {
        if (!active) return;
        setView(nextView);
        setProfile(nextProfile);
        if (nextView.status === 'ready' && nextProfile) {
          const allowed = new Set(nextView.scenario.eligibility.elements);
          setSelectedOwned(
            nextProfile.characters
              .filter(
                ({ element, level }) =>
                  allowed.has(element.toLowerCase() as never) &&
                  (level ?? 0) >= nextView.scenario.eligibility.minimumLevel
              )
              .map(({ id }) => String(id))
          );
        }
      })
      .catch(() => active && setLoadError('读取角色或剧诗资料失败。'));
    return () => {
      active = false;
      sequence.current += 1;
      const correlation = activeCorrelation.current;
      activeCorrelation.current = null;
      if (correlation) void api.theaterAdvisor.cancel({ correlationId: correlation });
    };
  }, [uid]);

  useEffect(
    () =>
      api.theaterAdvisor.onEvent((event) => {
        if (event.correlationId === activeCorrelation.current) setActiveStep(event.step);
      }),
    []
  );

  const scenario = view?.status === 'ready' ? view.scenario : null;
  const preview = useMemo(
    () =>
      scenario && profile
        ? qualificationPreview(scenario, profile.characters, selectedPools)
        : null,
    [scenario, profile, selectedPools]
  );
  const scenarioReadOnly =
    view?.status === 'ready' && view.trust === 'production' && view.notCurrent;

  function invalidate() {
    setResult(null);
    setActiveStep(null);
  }
  function toggleOwned(id: string) {
    if (running) return;
    setSelectedOwned((previous) =>
      previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]
    );
    invalidate();
  }
  function togglePool(source: string, id: string) {
    if (running) return;
    setSelectedPools((previous) => ({
      ...previous,
      [source]: previous[source]?.includes(id)
        ? previous[source]!.filter((item) => item !== id)
        : [...(previous[source] ?? []), id]
    }));
    invalidate();
  }
  function togglePreference(key: 'comfort' | 'survival' | 'lowInvestment' | 'noBuildChange') {
    setPreferences((previous) =>
      key === 'noBuildChange'
        ? { ...previous, noBuildChange: !previous.noBuildChange }
        : { ...previous, [key]: previous[key] === 'high' ? 'off' : 'high' }
    );
    invalidate();
  }
  async function generate() {
    if (!scenario || !preview || preview.shortage > 0 || scenarioReadOnly) return;
    const request = ++sequence.current;
    const correlationId = `theater-${Date.now()}-${request}`;
    activeCorrelation.current = correlationId;
    setRunning(true);
    setLoadError('');
    setResult(null);
    setActiveStep('reading-roster');
    try {
      const next = await api.theaterAdvisor.recommend({
        correlationId,
        uid,
        scenarioId: scenario.id,
        dataVersion: scenario.meta.dataVersion,
        target,
        preferences,
        selectedCharacterIds: selectedOwned,
        excludedCharacterIds: [],
        selectedOpeningCharacterIds: selectedPools.opening ?? [],
        selectedTrialCharacterIds: selectedPools.trial ?? [],
        selectedSpecialGuestCharacterIds: selectedPools['special-guest'] ?? [],
        selectedSupportCharacterIds: selectedPools.support ?? []
      });
      if (sequence.current === request) setResult(next);
    } catch {
      if (sequence.current === request)
        setLoadError('生成剧诗路线时发生错误；角色与挑战资料没有被修改。');
    } finally {
      if (sequence.current === request) {
        activeCorrelation.current = null;
        setRunning(false);
      }
    }
  }
  function cancel() {
    sequence.current += 1;
    const correlation = activeCorrelation.current;
    activeCorrelation.current = null;
    setRunning(false);
    setActiveStep(null);
    if (correlation) void api.theaterAdvisor.cancel({ correlationId: correlation });
  }

  if (loadError && (!view || !profile))
    return (
      <div className="gta-theater-unavailable" role="alert">
        {loadError}
      </div>
    );
  if (!view || !profile)
    return <div className="gta-theater-unavailable">正在读取演员与剧诗资料…</div>;
  if (view.status === 'unavailable')
    return (
      <section className="gta-theater-unavailable">
        <GtaButton tone="ghost" onClick={onBack}>
          返回挑战入口
        </GtaButton>
        <h3>本期剧诗资料暂不可用</h3>
        <p>{view.message}</p>
      </section>
    );
  if (!scenario || !preview) return null;

  return (
    <section className="gta-theater-workspace" aria-labelledby="theater-workspace-title">
      <header className="gta-theater-heading">
        <div>
          <GtaButton tone="ghost" onClick={onBack}>
            返回挑战入口
          </GtaButton>
          <span className="gta-page-kicker">演员池 · 活力 · 幕次路线</span>
          <h3 id="theater-workspace-title">幻想真境剧诗手册</h3>
          <p>先确认谁能入场，再把稀缺能力和活力留给关键幕次。</p>
        </div>
        <div className="gta-theater-stamp">
          <span>资料状态</span>
          <strong>{scenarioVersionLabel(view)}</strong>
        </div>
      </header>
      {view.trust === 'development-sample' && (
        <div className="gta-theater-banner" role="status">
          <strong>演练资料，不代表本期</strong>
          <span>元素、演员、敌人与路线都是原创交互样例。</span>
        </div>
      )}
      {scenarioReadOnly && (
        <div className="gta-theater-banner" role="status">
          <strong>资料已过期，仅供查看</strong>
          <span>为避免误导，暂时不能据此生成本期路线。</span>
        </div>
      )}
      {view.trust === 'production' && view.refreshWarning && !scenarioReadOnly && (
        <div className="gta-theater-banner" role="status">
          <strong>正在使用最近确认资料</strong>
          <span>{view.refreshWarning}</span>
        </div>
      )}

      <section className="gta-theater-eligibility" aria-labelledby="theater-eligibility-title">
        <div className="gta-theater-section-head">
          <div>
            <span className="gta-page-kicker">入场资格</span>
            <h4 id="theater-eligibility-title">元素、等级与人数</h4>
          </div>
          <strong className={preview.shortage ? 'is-short' : 'is-ready'}>
            {preview.qualified} / {scenario.eligibility.requiredHeadcount} 名可入场
          </strong>
        </div>
        <div className="gta-theater-ruleline">
          <span>当期元素：{scenario.eligibility.elements.map(elementLabel).join('、')}</span>
          <span>最低等级：{scenario.eligibility.minimumLevel}</span>
          <span>人数要求：{scenario.eligibility.requiredHeadcount}</span>
        </div>
        {preview.shortage > 0 && (
          <div className="gta-theater-shortage" role="alert">
            <strong>还缺 {preview.shortage} 名可入场角色</strong>
            <p>试用、特邀或支援演员的计数规则未在场景中说明时，暂不计入硬资格。</p>
            {preview.lowLevel.map((character) => (
              <p key={character.id}>
                优先提升 {character.name} 至 {scenario.eligibility.minimumLevel}{' '}
                级可补位（应用内建议，不是官方攻略）。
              </p>
            ))}
          </div>
        )}
      </section>

      <section className="gta-theater-cast" aria-labelledby="theater-cast-title">
        <div className="gta-theater-section-head">
          <div>
            <span className="gta-page-kicker">当期演员</span>
            <h4 id="theater-cast-title">演员来源要分清</h4>
          </div>
          <p>外部演员不会冒充你已拥有的角色。</p>
        </div>
        <div className="gta-theater-pools">
          {(['opening', 'trial', 'special-guest', 'support'] as const).map((source) => (
            <Pool
              key={source}
              source={source}
              scenario={scenario}
              selected={selectedPools[source] ?? []}
              disabled={running}
              onToggle={togglePool}
            />
          ))}
        </div>
        <p className="gta-theater-unknown-rule">
          场景未说明外部演员是否计入硬资格，暂不计入；实际可用性以游戏内为准。
        </p>
      </section>

      <section className="gta-theater-roster" aria-labelledby="theater-roster-title">
        <div className="gta-theater-section-head">
          <div>
            <span className="gta-page-kicker">你的角色</span>
            <h4 id="theater-roster-title">选出优先纳入演员池的角色</h4>
          </div>
          <span>已优先 {selectedOwned.length} 名</span>
        </div>
        <div className="gta-theater-owned" aria-label="可入场角色">
          {preview.eligible.map((character) => (
            <button
              key={character.id}
              type="button"
              disabled={running}
              aria-pressed={selectedOwned.includes(String(character.id))}
              onClick={() => toggleOwned(String(character.id))}
            >
              <strong>{character.name}</strong>
              <small>
                {elementLabel(character.element)}元素 · 等级 {character.level}
              </small>
              <em>{selectedOwned.includes(String(character.id)) ? '优先纳入' : '可入场'}</em>
            </button>
          ))}
        </div>
        {preview.ineligible.length > 0 && (
          <details className="gta-theater-ineligible">
            <summary>查看不符合的自有角色（{preview.ineligible.length}）</summary>
            <ul>
              {preview.ineligible.map(({ character, reasons }) => (
                <li key={character.id}>
                  <strong>{character.name}</strong>
                  <span>{eligibilityReasonLabel(reasons)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="gta-theater-controls" aria-labelledby="theater-controls-title">
        <div className="gta-theater-section-head">
          <div>
            <span className="gta-page-kicker">本次目标</span>
            <h4 id="theater-controls-title">路线偏好</h4>
          </div>
        </div>
        <div className="gta-theater-objectives" role="group" aria-label="选择剧诗目标">
          {OBJECTIVES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={target === value}
              disabled={running}
              onClick={() => {
                setTarget(value);
                invalidate();
              }}
            >
              {objectiveLabel(value)}
            </button>
          ))}
        </div>
        <div className="gta-theater-preferences" role="group" aria-label="路线偏好">
          {[
            ['comfort', '操作简单'],
            ['survival', '生存优先'],
            ['lowInvestment', '低练度'],
            ['noBuildChange', '不换装备']
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={
                key === 'noBuildChange'
                  ? preferences.noBuildChange
                  : preferences[key as 'comfort' | 'survival' | 'lowInvestment'] === 'high'
              }
              disabled={running}
              onClick={() => togglePreference(key as never)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="gta-theater-runbar">
          <GtaButton
            onClick={() => void generate()}
            disabled={running || preview.shortage > 0 || scenarioReadOnly}
          >
            {running
              ? '正在规划路线…'
              : preview.shortage > 0
                ? '角色不足，暂不能生成'
                : '生成剧诗路线'}
          </GtaButton>
          <GtaButton tone="ghost" onClick={cancel} disabled={!running}>
            取消生成
          </GtaButton>
        </div>
      </section>

      {(running || activeStep) && (
        <ol className="gta-theater-progress" aria-label="路线生成进度" aria-live="polite">
          {PROGRESS.map((step, index) => {
            const current = activeStep ? PROGRESS.indexOf(activeStep) : -1;
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
        <p className="gta-theater-inline-error" role="alert">
          {loadError}
        </p>
      )}
      {result && <TheaterResult result={result} profile={profile} scenario={scenario} />}
    </section>
  );
}

function Pool({
  source,
  scenario,
  selected,
  disabled,
  onToggle
}: {
  source: 'opening' | 'trial' | 'special-guest' | 'support';
  scenario: TheaterScenario;
  selected: string[];
  disabled: boolean;
  onToggle: (source: string, id: string) => void;
}) {
  const key = source === 'special-guest' ? 'specialGuest' : source;
  return (
    <section>
      <span>{poolSourceLabel(source)}</span>
      {scenario.pools[key].length ? (
        scenario.pools[key].map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={disabled}
            aria-pressed={selected.includes(item.id)}
            onClick={() => onToggle(source, item.id)}
          >
            <strong>{theaterEntityName(item)}</strong>
            <small>{selected.includes(item.id) ? '已纳入路线考量' : '来源独立标记'}</small>
          </button>
        ))
      ) : (
        <p>当期未列出</p>
      )}
    </section>
  );
}

function TheaterResult({
  result,
  profile,
  scenario
}: {
  result: TheaterAdvisorResult;
  profile: PersistedProfile;
  scenario: TheaterScenario;
}) {
  if (result.status === 'blocked')
    return (
      <section className="gta-theater-result is-blocked">
        <h4>暂时不能生成有效路线</h4>
        <ul>
          {result.issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>{issue.message}</li>
          ))}
        </ul>
        {result.eligibility.constructionAdvice.map((advice, index) => (
          <p key={index}>{advice.note}</p>
        ))}
      </section>
    );
  const byId = new Map(profile.characters.map((character) => [String(character.id), character]));
  const poolById = new Map(
    Object.values(scenario.pools)
      .flat()
      .map((entity) => [entity.id, entity])
  );
  const actorName = (id: string) =>
    byId.get(id)?.name ?? (poolById.get(id) ? theaterEntityName(poolById.get(id)!) : '未命名演员');
  const castEntries = [
    ...result.plan.cast.selectedCharacterIds.map((id) => ({ id, source: 'owned' as const })),
    ...result.plan.cast.openingCharacterIds.map((id) => ({ id, source: 'opening' as const })),
    ...result.plan.cast.trialCharacterIds.map((id) => ({ id, source: 'trial' as const })),
    ...result.plan.cast.specialGuestCharacterIds.map((id) => ({
      id,
      source: 'special-guest' as const
    })),
    ...result.plan.cast.supportCharacterIds.map((id) => ({ id, source: 'support' as const }))
  ];
  return (
    <section className="gta-theater-result" aria-labelledby="theater-result-title">
      <header>
        <div>
          <span className="gta-page-kicker">路线计划</span>
          <h4 id="theater-result-title">演员池与活力已排成幕次路线</h4>
        </div>
        <span>{result.source === 'smart-service' ? '智能服务' : '本地规则'}</span>
      </header>
      <section className="gta-theater-result-cast">
        <h5>入场演员池</h5>
        <div>
          {castEntries.map(({ id, source }) => (
            <span key={`${source}:${id}`} data-theater-actor-id={id}>
              <strong>{actorName(id)}</strong>
              <small>{source === 'owned' ? '自有角色' : poolSourceLabel(source)}</small>
            </span>
          ))}
        </div>
      </section>
      <section className="gta-theater-vigor">
        <h5>逐幕活力预算</h5>
        <div>
          {result.vigorBudget.map((item) => (
            <span key={`${item.act}:${item.characterId}`}>
              <small>
                第 {item.act} 幕 · {actorName(item.characterId)}
              </small>
              <strong>
                {item.before} → {item.after}
              </strong>
              <em>计划花费 {item.spent}</em>
            </span>
          ))}
        </div>
      </section>
      <div className="gta-theater-route" aria-label="剧诗幕次路线">
        {result.plan.acts.map((act) => {
          const scenarioAct = scenario.acts.find((item) => item.act === act.act);
          const presentation = scenarioAct ? theaterActPresentation(scenarioAct) : null;
          return (
            <article key={act.act}>
              <div className="gta-theater-route-node">
                <span>{String(act.act).padStart(2, '0')}</span>
              </div>
              <div>
                <h5>第 {act.act} 幕候选</h5>
                <p>{act.candidateCharacterIds.map(actorName).join('、')}</p>
                {presentation && (
                  <div className="gta-theater-act-encounters">
                    {presentation.waves.map((wave) => (
                      <section key={`${act.act}:${wave.label}`}>
                        <strong>{wave.label}</strong>
                        {wave.spawnCondition && <small>{wave.spawnCondition}</small>}
                        {wave.enemies.map((enemy, index) => (
                          <div key={`${enemy.name}:${index}`}>
                            <span>
                              {enemy.name} ×{enemy.count} · {enemy.level} 级
                            </span>
                            {enemy.mechanics.length > 0 && (
                              <ul>
                                {enemy.mechanics.map((mechanic) => (
                                  <li key={mechanic}>{mechanic}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                        ))}
                      </section>
                    ))}
                  </div>
                )}
                <div className="gta-theater-act-rationale">
                  <strong>为什么这样安排</strong>
                  <p>{pathChoiceLabel(act.pathChoice)}</p>
                </div>
                <small>
                  预计活力：
                  {act.plannedVigorSpend
                    .map((item) => `${actorName(item.characterId)} ${item.cost}`)
                    .join('、') || '现场保留'}
                </small>
              </div>
            </article>
          );
        })}
      </div>
      <section className="gta-theater-preserve">
        <h5>保留与分支优先级</h5>
        {result.routeGuidance.preserveCharacterIds.length > 0 && (
          <p>
            <strong>优先保留：</strong>
            {result.routeGuidance.preserveCharacterIds.map(actorName).join('、')}
          </p>
        )}
        {result.routeGuidance.notes.map((note) => (
          <p key={note}>{note}</p>
        ))}
        {result.routeGuidance.arcanaPriorities.length > 0 && (
          <ol className="gta-theater-arcana">
            {result.routeGuidance.arcanaPriorities.map((priority) => {
              const budget = result.nodeBudget.find(({ nodeId }) => nodeId === priority.nodeId);
              return (
                <li key={priority.nodeId}>
                  <strong>{priority.name}</strong>
                  <span>触发条件：{priority.condition}</span>
                  <span>选择依据：{priority.reason}</span>
                  <small>节点资源消耗：{budget?.cost ?? '资料未确认'}</small>
                </li>
              );
            })}
          </ol>
        )}
      </section>
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

function qualificationPreview(
  scenario: TheaterScenario,
  characters: CharacterProfile[],
  selectedPools: Record<string, string[]>
) {
  const allowed = new Set(scenario.eligibility.elements);
  const selectedNonGuestExternal = new Set([
    ...(selectedPools['opening'] ?? []),
    ...(selectedPools['trial'] ?? []),
    ...(selectedPools['support'] ?? [])
  ]);
  const selectedSpecialGuests = new Set(selectedPools['special-guest'] ?? []);
  const configuredSpecialGuests = new Set(scenario.pools.specialGuest.map(({ id }) => id));
  const eligible: CharacterProfile[] = [];
  const ineligible: Array<{ character: CharacterProfile; reasons: Array<'element' | 'level'> }> =
    [];
  for (const character of characters) {
    const id = String(character.id);
    if (selectedNonGuestExternal.has(id)) continue;
    const reasons: Array<'element' | 'level'> = [];
    const specialGuest = selectedSpecialGuests.has(id) && configuredSpecialGuests.has(id);
    if (!allowed.has(character.element.toLowerCase() as never) && !specialGuest)
      reasons.push('element');
    if ((character.level ?? 0) < scenario.eligibility.minimumLevel) reasons.push('level');
    if (reasons.length) ineligible.push({ character, reasons });
    else eligible.push(character);
  }
  return {
    eligible,
    ineligible,
    qualified: eligible.length,
    shortage: Math.max(0, scenario.eligibility.requiredHeadcount - eligible.length),
    lowLevel: ineligible
      .filter(({ reasons }) => reasons.length === 1 && reasons[0] === 'level')
      .map(({ character }) => character)
  };
}
