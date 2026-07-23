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
import { EmptyState } from '../../components/ui/EmptyState';
import { GtaButton } from '../../components/ui/GtaButton';
import { useI18n } from '../../i18n';
import { api } from '../../ipc';
import { localizedResultText, type PresentationLocale } from './abyss-presentation';
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
import type { HistoryRerunIntent } from '../History/history-presentation';
import { historySourceChangedNotice, prepareTheaterRerun } from './history-rerun-prefill';

const PROGRESS: TheaterAdvisorProgressStep[] = [
  'reading-roster',
  'checking-eligibility',
  'planning-cast',
  'budgeting-vigor',
  'writing-route'
];
const OBJECTIVES: TheaterObjective[] = ['eligibility-check', 'safe-clear', 'explore-hard'];

export function TheaterWorkspace({
  uid,
  historyRerun,
  onHistoryRerunConsumed,
  onBack
}: {
  uid: string;
  historyRerun?: Extract<HistoryRerunIntent, { mode: 'imaginarium-theater' }>;
  onHistoryRerunConsumed?: (historyId: string) => void;
  onBack: () => void;
}) {
  const { locale } = useI18n();
  const language: PresentationLocale = locale === 'en-US' ? 'en' : 'zh';
  const isEnglish = language === 'en';
  const [view, setView] = useState<TheaterScenarioView | null>(null);
  const [profile, setProfile] = useState<PersistedProfile | null>(null);
  const [loadError, setLoadError] = useState<'load' | 'generate' | ''>('');
  const [target, setTarget] = useState<TheaterObjective>('safe-clear');
  const [act, setAct] = useState<number | 'all'>('all');
  const [selectedOwned, setSelectedOwned] = useState<string[]>([]);
  const [excludedOwned, setExcludedOwned] = useState<string[]>([]);
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
  const pendingHistoryRerun = useRef(historyRerun);
  const historyConsumedCallback = useRef(onHistoryRerunConsumed);
  historyConsumedCallback.current = onHistoryRerunConsumed;
  const [historyNotice, setHistoryNotice] = useState('');

  useEffect(() => {
    let active = true;
    setHistoryNotice('');
    void Promise.all([api.theaterAdvisor.getScenario(), api.profile.get({ uid })])
      .then(([nextView, nextProfile]) => {
        if (!active) return;
        setView(nextView);
        setProfile(nextProfile);
        if (nextView.status === 'ready' && nextProfile) {
          const allowed = new Set(nextView.scenario.eligibility.elements);
          const eligibleOwned = nextProfile.characters
            .filter(
              ({ element, level }) =>
                allowed.has(element.toLowerCase() as never) &&
                (level ?? 0) >= nextView.scenario.eligibility.minimumLevel
            )
            .map(({ id }) => String(id));
          setSelectedOwned(eligibleOwned);
          const rerun = pendingHistoryRerun.current;
          if (rerun) {
            const prepared = prepareTheaterRerun(
              rerun,
              uid,
              nextView.scenario.acts.map(({ act: number }) => number),
              eligibleOwned,
              {
                scenarioId: nextView.scenario.id,
                dataVersion: nextView.scenario.meta.dataVersion
              }
            );
            if (prepared.status === 'blocked') {
              setHistoryNotice('这份旧方案属于另一个 UID；已保留旧方案查看，但没有带入当前账号。');
            } else {
              const pools = nextView.scenario.pools;
              const retainPool = (ids: string[], candidates: Array<{ id: string }>) => {
                const available = new Set(candidates.map(({ id }) => id));
                return ids.filter((id) => available.has(id));
              };
              const selectedOpening = retainPool(
                prepared.selectedOpeningCharacterIds,
                pools.opening
              );
              const selectedTrial = retainPool(prepared.selectedTrialCharacterIds, pools.trial);
              const selectedSpecial = retainPool(
                prepared.selectedSpecialGuestCharacterIds,
                pools.specialGuest
              );
              const selectedSupport = retainPool(
                prepared.selectedSupportCharacterIds,
                pools.support
              );
              const removedExternal =
                prepared.selectedOpeningCharacterIds.length +
                prepared.selectedTrialCharacterIds.length +
                prepared.selectedSpecialGuestCharacterIds.length +
                prepared.selectedSupportCharacterIds.length -
                selectedOpening.length -
                selectedTrial.length -
                selectedSpecial.length -
                selectedSupport.length;
              setAct(prepared.act ?? 'all');
              setTarget(prepared.target);
              setPreferences(prepared.preferences);
              setSelectedOwned(prepared.selectedCharacterIds);
              setExcludedOwned(prepared.excludedCharacterIds);
              setSelectedPools({
                opening: selectedOpening,
                trial: selectedTrial,
                'special-guest': selectedSpecial,
                support: selectedSupport
              });
              const changed = prepared.status === 'adjusted' || removedExternal > 0;
              setHistoryNotice(
                `${historySourceChangedNotice(prepared, 'zh')}${
                  changed
                    ? `已带入旧方案的可用选择；${
                        prepared.targetUnavailable ? '原幕次已不在当前资料中；' : ''
                      }${
                        prepared.removedCharacterCount + removedExternal > 0
                          ? `${prepared.removedCharacterCount + removedExternal} 名当前不可用的演员未带入；`
                          : ''
                      }请检查后再点击生成，不会自动调用智能服务。`
                    : '已带入旧方案的幕次、目标、偏好、演员与外援选择。请检查后再点击生成，不会自动调用智能服务。'
                }`
              );
            }
            pendingHistoryRerun.current = undefined;
            historyConsumedCallback.current?.(rerun.historyId);
          }
        }
      })
      .catch(() => active && setLoadError('load'));
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
    if (selectedOwned.includes(id)) {
      setSelectedOwned((previous) => previous.filter((item) => item !== id));
      setExcludedOwned((previous) => [...previous, id]);
    } else if (excludedOwned.includes(id)) {
      setExcludedOwned((previous) => previous.filter((item) => item !== id));
    } else {
      setSelectedOwned((previous) => [...previous, id]);
    }
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
        locale,
        ...(act === 'all' ? {} : { act }),
        target,
        preferences,
        selectedCharacterIds: selectedOwned,
        excludedCharacterIds: excludedOwned,
        selectedOpeningCharacterIds: selectedPools.opening ?? [],
        selectedTrialCharacterIds: selectedPools.trial ?? [],
        selectedSpecialGuestCharacterIds: selectedPools['special-guest'] ?? [],
        selectedSupportCharacterIds: selectedPools.support ?? []
      });
      if (sequence.current === request) setResult(next);
    } catch {
      if (sequence.current === request) setLoadError('generate');
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
        <EmptyState kind="offline" locale={language} />
        <p>
          {isEnglish
            ? 'Roster or Imaginarium Theater data could not be loaded.'
            : '读取角色或剧诗资料失败。'}
        </p>
      </div>
    );
  if (!view || !profile)
    return (
      <div className="gta-theater-unavailable">
        {isEnglish ? 'Loading cast and Theater data…' : '正在读取演员与剧诗资料…'}
      </div>
    );
  if (view.status === 'unavailable')
    return (
      <section className="gta-theater-unavailable">
        <GtaButton tone="ghost" onClick={onBack}>
          {isEnglish ? 'Back to challenge selection' : '返回挑战入口'}
        </GtaButton>
        <EmptyState kind="offline" locale={language} />
        <p>
          {isEnglish
            ? 'Verified Imaginarium Theater data is unavailable. Saved plans remain available.'
            : view.message}
        </p>
      </section>
    );
  if (!scenario || !preview) return null;

  return (
    <section className="gta-theater-workspace" aria-labelledby="theater-workspace-title">
      <header className="gta-theater-heading">
        <div>
          <GtaButton tone="ghost" onClick={onBack}>
            {isEnglish ? 'Back to challenge selection' : '返回挑战入口'}
          </GtaButton>
          <span className="gta-page-kicker">
            {isEnglish ? 'Cast · Vigor · Act route' : '演员池 · 活力 · 幕次路线'}
          </span>
          <h3 id="theater-workspace-title">
            {isEnglish ? 'Imaginarium Theater planner' : '幻想真境剧诗手册'}
          </h3>
          <p>
            {isEnglish
              ? 'Confirm who is eligible, then reserve scarce capabilities and Vigor for key acts.'
              : '先确认谁能入场，再把稀缺能力和活力留给关键幕次。'}
          </p>
        </div>
        <div className="gta-theater-stamp">
          <span>{isEnglish ? 'Data status' : '资料状态'}</span>
          <strong>{scenarioVersionLabel(view, language)}</strong>
        </div>
      </header>
      {view.trust === 'development-sample' && (
        <div className="gta-theater-banner" role="status">
          <strong>
            {isEnglish ? 'Practice data — not the current cycle' : '演练资料，不代表本期'}
          </strong>
          <span>
            {isEnglish
              ? 'Elements, actors, enemies, and routes are original interaction samples.'
              : '元素、演员、敌人与路线都是原创交互样例。'}
          </span>
        </div>
      )}
      {historyNotice && (
        <div className="gta-theater-banner is-history-prefill" role="status">
          <strong>{isEnglish ? 'Saved plan ready' : '旧方案已准备'}</strong>
          <span>
            {isEnglish
              ? 'Available saved choices were restored. Review them before generating; the smart service will not start automatically.'
              : historyNotice}
          </span>
        </div>
      )}
      {scenarioReadOnly && (
        <div className="gta-theater-banner" role="status">
          <strong>{isEnglish ? 'Outdated data — view only' : '资料已过期，仅供查看'}</strong>
          <span>
            {isEnglish
              ? 'New current-cycle routes are disabled to avoid misleading results.'
              : '为避免误导，暂时不能据此生成本期路线。'}
          </span>
        </div>
      )}
      {view.trust === 'production' && view.refreshWarning && !scenarioReadOnly && (
        <div className="gta-theater-banner" role="status">
          <strong>
            {isEnglish ? 'Using the latest verified snapshot' : '正在使用最近确认资料'}
          </strong>
          <span>
            {isEnglish
              ? 'Refresh did not complete. Check the data version before generating.'
              : view.refreshWarning}
          </span>
        </div>
      )}

      <section className="gta-theater-eligibility" aria-labelledby="theater-eligibility-title">
        <div className="gta-theater-section-head">
          <div>
            <span className="gta-page-kicker">{isEnglish ? 'Eligibility' : '入场资格'}</span>
            <h4 id="theater-eligibility-title">
              {isEnglish ? 'Elements, level, and headcount' : '元素、等级与人数'}
            </h4>
          </div>
          <strong className={preview.shortage ? 'is-short' : 'is-ready'}>
            {isEnglish
              ? `${preview.qualified} / ${scenario.eligibility.requiredHeadcount} eligible`
              : `${preview.qualified} / ${scenario.eligibility.requiredHeadcount} 名可入场`}
          </strong>
        </div>
        <div className="gta-theater-ruleline">
          <span>
            {isEnglish ? 'Current elements: ' : '当期元素：'}
            {scenario.eligibility.elements
              .map((element) => elementLabel(element, language))
              .join(isEnglish ? ', ' : '、')}
          </span>
          <span>
            {isEnglish ? 'Minimum level: ' : '最低等级：'}
            {scenario.eligibility.minimumLevel}
          </span>
          <span>
            {isEnglish ? 'Required headcount: ' : '人数要求：'}
            {scenario.eligibility.requiredHeadcount}
          </span>
        </div>
        {preview.shortage > 0 && (
          <div className="gta-theater-shortage" role="alert">
            <strong>
              {isEnglish
                ? `${preview.shortage} more eligible ${preview.shortage === 1 ? 'character is' : 'characters are'} required`
                : `还缺 ${preview.shortage} 名可入场角色`}
            </strong>
            <p>
              {isEnglish
                ? 'Opening, Trial, and Support actors do not count toward hard eligibility; unknown rules are not assumed satisfied.'
                : '开幕、试用与支援演员暂不计入硬资格；未知规则不会按已满足处理。'}
            </p>
            {preview.lowLevel.map((character) => (
              <p key={character.id}>
                {isEnglish
                  ? `Raise ${character.name} to level ${scenario.eligibility.minimumLevel} to fill a slot (in-app suggestion, not official guidance).`
                  : `优先提升 ${character.name} 至 ${scenario.eligibility.minimumLevel} 级可补位（应用内建议，不是官方攻略）。`}
              </p>
            ))}
          </div>
        )}
        {preview.qualifiedSpecialGuests.length > 0 && (
          <p className="gta-theater-special-guest-rule" role="status">
            {isEnglish
              ? 'Owned Special Guests bypass only the element restriction and must still meet the minimum level. Counted here: '
              : '自有特邀演员只绕过元素限制，仍需满足最低等级；本次已计入：'}
            {preview.qualifiedSpecialGuests.map(({ name }) => name).join('、')}
          </p>
        )}
      </section>

      <section className="gta-theater-cast" aria-labelledby="theater-cast-title">
        <div className="gta-theater-section-head">
          <div>
            <span className="gta-page-kicker">{isEnglish ? 'Current cast' : '当期演员'}</span>
            <h4 id="theater-cast-title">
              {isEnglish ? 'Keep actor sources explicit' : '演员来源要分清'}
            </h4>
          </div>
          <p>
            {isEnglish
              ? 'External actors are never presented as owned characters.'
              : '外部演员不会冒充你已拥有的角色。'}
          </p>
        </div>
        <div className="gta-theater-pools">
          {(['opening', 'trial', 'special-guest', 'support'] as const).map((source) => (
            <Pool
              key={source}
              source={source}
              scenario={scenario}
              selected={selectedPools[source] ?? []}
              disabled={running}
              locale={language}
              onToggle={togglePool}
            />
          ))}
        </div>
        <p className="gta-theater-unknown-rule">
          {isEnglish
            ? 'Opening, Trial, and Support actors do not count toward hard eligibility. Owned Special Guests count only at the required level and keep their source label.'
            : '开幕、试用与支援演员暂不计入硬资格；自有特邀演员仅在等级达标后计入，并保留特邀来源标记。'}
        </p>
      </section>

      <section className="gta-theater-roster" aria-labelledby="theater-roster-title">
        <div className="gta-theater-section-head">
          <div>
            <span className="gta-page-kicker">{isEnglish ? 'Your roster' : '你的角色'}</span>
            <h4 id="theater-roster-title">
              {isEnglish ? 'Choose priority cast members' : '选出优先纳入演员池的角色'}
            </h4>
          </div>
          <span>
            {isEnglish
              ? `${selectedOwned.length} prioritized`
              : `已优先 ${selectedOwned.length} 名`}
          </span>
        </div>
        <div
          className="gta-theater-owned"
          aria-label={isEnglish ? 'Eligible characters' : '可入场角色'}
        >
          {preview.eligible.map((character) => (
            <button
              key={character.id}
              type="button"
              disabled={running}
              aria-pressed={selectedOwned.includes(String(character.id))}
              data-state={
                selectedOwned.includes(String(character.id))
                  ? 'selected'
                  : excludedOwned.includes(String(character.id))
                    ? 'excluded'
                    : 'neutral'
              }
              onClick={() => toggleOwned(String(character.id))}
            >
              <strong>{character.name}</strong>
              <small>
                {isEnglish
                  ? `${elementLabel(character.element, language)} · Level ${character.level}`
                  : `${elementLabel(character.element, language)}元素 · 等级 ${character.level}`}
              </small>
              <em>
                {selectedOwned.includes(String(character.id))
                  ? isEnglish
                    ? 'Prioritize'
                    : '优先纳入'
                  : excludedOwned.includes(String(character.id))
                    ? isEnglish
                      ? 'Exclude this run'
                      : '本次排除'
                    : isEnglish
                      ? 'Eligible'
                      : '可入场'}
              </em>
            </button>
          ))}
        </div>
        {preview.ineligible.length > 0 && (
          <details className="gta-theater-ineligible">
            <summary>
              {isEnglish
                ? `Review ineligible owned characters (${preview.ineligible.length})`
                : `查看不符合的自有角色（${preview.ineligible.length}）`}
            </summary>
            <ul>
              {preview.ineligible.map(({ character, reasons }) => (
                <li key={character.id}>
                  <strong>{character.name}</strong>
                  <span>{eligibilityReasonLabel(reasons, language)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="gta-theater-controls" aria-labelledby="theater-controls-title">
        <div className="gta-theater-section-head">
          <div>
            <span className="gta-page-kicker">{isEnglish ? 'Plan target' : '本次目标'}</span>
            <h4 id="theater-controls-title">{isEnglish ? 'Route preferences' : '路线偏好'}</h4>
          </div>
        </div>
        <div
          className="gta-theater-objectives"
          role="group"
          aria-label={isEnglish ? 'Choose acts to plan' : '选择规划幕次'}
        >
          <button
            type="button"
            aria-pressed={act === 'all'}
            disabled={running}
            onClick={() => {
              setAct('all');
              invalidate();
            }}
          >
            {isEnglish ? 'All acts' : '全部幕次'}
          </button>
          {scenario.acts.map(({ act: number }) => (
            <button
              key={number}
              type="button"
              aria-pressed={act === number}
              disabled={running}
              onClick={() => {
                setAct(number);
                invalidate();
              }}
            >
              {isEnglish ? `Act ${number}` : `第 ${number} 幕`}
            </button>
          ))}
        </div>
        <div
          className="gta-theater-objectives"
          role="group"
          aria-label={isEnglish ? 'Choose Theater goal' : '选择剧诗目标'}
        >
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
              {objectiveLabel(value, language)}
            </button>
          ))}
        </div>
        <div
          className="gta-theater-preferences"
          role="group"
          aria-label={isEnglish ? 'Route preferences' : '路线偏好'}
        >
          {[
            ['comfort', isEnglish ? 'Simple rotations' : '操作简单'],
            ['survival', isEnglish ? 'Prioritize survival' : '生存优先'],
            ['lowInvestment', isEnglish ? 'Lower investment' : '低练度'],
            ['noBuildChange', isEnglish ? 'Keep current builds' : '不换装备']
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
              ? isEnglish
                ? 'Planning route…'
                : '正在规划路线…'
              : preview.shortage > 0
                ? isEnglish
                  ? 'Not enough eligible characters'
                  : '角色不足，暂不能生成'
                : isEnglish
                  ? 'Generate Theater route'
                  : '生成剧诗路线'}
          </GtaButton>
          <GtaButton tone="ghost" onClick={cancel} disabled={!running}>
            {isEnglish ? 'Cancel generation' : '取消生成'}
          </GtaButton>
        </div>
      </section>

      {(running || activeStep) && (
        <ol
          className="gta-theater-progress"
          aria-label={isEnglish ? 'Route generation progress' : '路线生成进度'}
          aria-live="polite"
        >
          {PROGRESS.map((step, index) => {
            const current = activeStep ? PROGRESS.indexOf(activeStep) : -1;
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
        <p className="gta-theater-inline-error" role="alert">
          {isEnglish
            ? 'The Theater route could not be generated. Character and challenge data were not changed.'
            : '生成剧诗路线时发生错误；角色与挑战资料没有被修改。'}
        </p>
      )}
      {result && (
        <TheaterResult result={result} profile={profile} scenario={scenario} locale={language} />
      )}
    </section>
  );
}

function Pool({
  source,
  scenario,
  selected,
  disabled,
  locale,
  onToggle
}: {
  source: 'opening' | 'trial' | 'special-guest' | 'support';
  scenario: TheaterScenario;
  selected: string[];
  disabled: boolean;
  locale: PresentationLocale;
  onToggle: (source: string, id: string) => void;
}) {
  const isEnglish = locale === 'en';
  const key = source === 'special-guest' ? 'specialGuest' : source;
  return (
    <section>
      <span>{poolSourceLabel(source, locale)}</span>
      {scenario.pools[key].length ? (
        scenario.pools[key].map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={disabled}
            aria-pressed={selected.includes(item.id)}
            onClick={() => onToggle(source, item.id)}
          >
            <strong>{theaterEntityName(item, locale)}</strong>
            <small>
              {selected.includes(item.id)
                ? isEnglish
                  ? 'Included in route planning'
                  : '已纳入路线考量'
                : isEnglish
                  ? 'Source kept explicit'
                  : '来源独立标记'}
            </small>
          </button>
        ))
      ) : (
        <p>{isEnglish ? 'None listed for this cycle' : '当期未列出'}</p>
      )}
    </section>
  );
}

function TheaterResult({
  result,
  profile,
  scenario,
  locale
}: {
  result: TheaterAdvisorResult;
  profile: PersistedProfile;
  scenario: TheaterScenario;
  locale: PresentationLocale;
}) {
  const isEnglish = locale === 'en';
  if (result.status === 'blocked')
    return (
      <section className="gta-theater-result is-blocked">
        <h4>{isEnglish ? 'A valid route cannot be generated yet' : '暂时不能生成有效路线'}</h4>
        <ul>
          {result.issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>
              {isEnglish
                ? `Planning constraint ${index + 1} is not satisfied by the current choices.`
                : issue.message}
            </li>
          ))}
        </ul>
        {result.eligibility.constructionAdvice.map((advice, index) => (
          <p key={index}>
            {localizedResultText(
              advice.note,
              locale,
              'Adjust the selected cast to satisfy the published eligibility rules.'
            )}
          </p>
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
    byId.get(id)?.name ??
    (poolById.get(id)
      ? theaterEntityName(poolById.get(id)!, locale)
      : isEnglish
        ? 'Unnamed actor'
        : '未命名演员');
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
          <span className="gta-page-kicker">{isEnglish ? 'Route plan' : '路线计划'}</span>
          <h4 id="theater-result-title">
            {isEnglish ? 'Cast and Vigor arranged into an act route' : '演员池与活力已排成幕次路线'}
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
      <section className="gta-theater-result-cast">
        <h5>{isEnglish ? 'Selected cast' : '入场演员池'}</h5>
        <div>
          {castEntries.map(({ id, source }) => (
            <span key={`${source}:${id}`} data-theater-actor-id={id}>
              <strong>{actorName(id)}</strong>
              <small>
                {source === 'owned'
                  ? isEnglish
                    ? 'Owned character'
                    : '自有角色'
                  : poolSourceLabel(source, locale)}
              </small>
            </span>
          ))}
        </div>
      </section>
      <section className="gta-theater-vigor">
        <h5>{isEnglish ? 'Vigor budget by act' : '逐幕活力预算'}</h5>
        <div>
          {result.vigorBudget.map((item) => (
            <span key={`${item.act}:${item.characterId}`}>
              <small>
                {isEnglish ? `Act ${item.act}` : `第 ${item.act} 幕`} ·{' '}
                {actorName(item.characterId)}
              </small>
              <strong>
                {item.before} → {item.after}
              </strong>
              <em>{isEnglish ? `Planned spend ${item.spent}` : `计划花费 ${item.spent}`}</em>
            </span>
          ))}
        </div>
      </section>
      <div
        className="gta-theater-route"
        aria-label={isEnglish ? 'Imaginarium Theater act route' : '剧诗幕次路线'}
      >
        {result.plan.acts.map((act) => {
          const scenarioAct = scenario.acts.find((item) => item.act === act.act);
          const presentation = scenarioAct ? theaterActPresentation(scenarioAct, locale) : null;
          return (
            <article key={act.act}>
              <div className="gta-theater-route-node">
                <span>{String(act.act).padStart(2, '0')}</span>
              </div>
              <div>
                <h5>{isEnglish ? `Act ${act.act} candidates` : `第 ${act.act} 幕候选`}</h5>
                <p>{act.candidateCharacterIds.map(actorName).join(isEnglish ? ', ' : '、')}</p>
                {presentation && (
                  <div className="gta-theater-act-encounters">
                    {presentation.waves.map((wave) => (
                      <section key={`${act.act}:${wave.label}`}>
                        <strong>{wave.label}</strong>
                        {wave.spawnCondition && <small>{wave.spawnCondition}</small>}
                        {wave.enemies.map((enemy, index) => (
                          <div key={`${enemy.name}:${index}`}>
                            <span>
                              {enemy.name} ×{enemy.count} ·{' '}
                              {isEnglish ? `Level ${enemy.level}` : `${enemy.level} 级`}
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
                  <strong>{isEnglish ? 'Why this arrangement' : '为什么这样安排'}</strong>
                  <p>{pathChoiceLabel(act.pathChoice, locale)}</p>
                </div>
                <small>
                  {isEnglish ? 'Planned Vigor: ' : '预计活力：'}
                  {act.plannedVigorSpend
                    .map((item) => `${actorName(item.characterId)} ${item.cost}`)
                    .join(isEnglish ? ', ' : '、') || (isEnglish ? 'Hold for the run' : '现场保留')}
                </small>
              </div>
            </article>
          );
        })}
      </div>
      <section className="gta-theater-preserve">
        <h5>{isEnglish ? 'Preservation and branch priorities' : '保留与分支优先级'}</h5>
        {result.routeGuidance.preserveCharacterIds.length > 0 && (
          <p>
            <strong>{isEnglish ? 'Preserve first: ' : '优先保留：'}</strong>
            {result.routeGuidance.preserveCharacterIds.map(actorName).join(isEnglish ? ', ' : '、')}
          </p>
        )}
        {result.routeGuidance.notes.map((note) => (
          <p key={note}>
            {localizedResultText(
              note,
              locale,
              'Preserve scarce capabilities for later route branches.'
            )}
          </p>
        ))}
        {result.routeGuidance.arcanaPriorities.length > 0 && (
          <ol className="gta-theater-arcana">
            {result.routeGuidance.arcanaPriorities.map((priority) => {
              const budget = result.nodeBudget.find(({ nodeId }) => nodeId === priority.nodeId);
              return (
                <li key={priority.nodeId}>
                  <strong>
                    {localizedResultText(priority.name, locale, 'Saved Arcana priority')}
                  </strong>
                  <span>
                    {isEnglish ? 'Trigger: ' : '触发条件：'}
                    {isEnglish && /[\u3400-\u9fff]/u.test(priority.condition)
                      ? 'Condition saved with the plan'
                      : priority.condition}
                  </span>
                  <span>
                    {isEnglish ? 'Reason: ' : '选择依据：'}
                    {isEnglish && /[\u3400-\u9fff]/u.test(priority.reason)
                      ? 'Reason saved with the plan'
                      : priority.reason}
                  </span>
                  <small>
                    {isEnglish ? 'Node cost: ' : '节点资源消耗：'}
                    {budget?.cost ?? (isEnglish ? 'Not verified' : '资料未确认')}
                  </small>
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
              <strong>{isEnglish ? 'Watch for: ' : '需要留意：'}</strong>
              {result.warnings
                .map((text) =>
                  localizedResultText(
                    text,
                    locale,
                    'Verify route assumptions against the current run.'
                  )
                )
                .join(isEnglish ? '; ' : '；')}
            </p>
          )}
          {result.assumptions.length > 0 && (
            <p>
              <strong>{isEnglish ? 'This recommendation assumes: ' : '本次建议基于：'}</strong>
              {result.assumptions
                .map((text) =>
                  localizedResultText(
                    text,
                    locale,
                    'Only verified eligibility and route facts are treated as confirmed.'
                  )
                )
                .join(isEnglish ? '; ' : '；')}
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
  const qualifiedSpecialGuests: CharacterProfile[] = [];
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
    else {
      eligible.push(character);
      if (specialGuest) qualifiedSpecialGuests.push(character);
    }
  }
  return {
    eligible,
    qualifiedSpecialGuests,
    ineligible,
    qualified: eligible.length,
    shortage: Math.max(0, scenario.eligibility.requiredHeadcount - eligible.length),
    lowLevel: ineligible
      .filter(({ reasons }) => reasons.length === 1 && reasons[0] === 'level')
      .map(({ character }) => character)
  };
}
