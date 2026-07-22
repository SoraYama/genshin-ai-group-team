import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../ipc';
import type { AdvisorEvent, ProfileStateView, RecommendationResult } from '../../../shared/domain';
import { ButtonGlyph } from '../../design/Icons';
import { localizeError, useI18n } from '../../i18n';
import { ChallengeModeEntry, type ChallengeMode } from '../../components/ChallengeModeEntry';
import { GtaButton } from '../../components/ui/GtaButton';
import { OrnamentPanel } from '../../components/ui/OrnamentPanel';

interface AdvisorPageProps {
  state: ProfileStateView;
  onGotoOnboarding: () => void;
}

type Mode = 'single' | 'compare';

interface SideState {
  stage: string;
  message: string;
  streamText: string;
  result: RecommendationResult | null;
}

interface RunState {
  kind: 'idle' | 'running' | 'cancelled' | 'error';
  message?: string;
}

const DEFAULT_ENEMIES_SINGLE = 'abyss-mage, ruin-guard';
function emptySideState(): SideState {
  return { stage: '', message: '', streamText: '', result: null };
}

export function AdvisorPage({ state, onGotoOnboarding }: AdvisorPageProps) {
  const { locale, t } = useI18n();
  const activeUid = state.activeUid;
  const [mode, setMode] = useState<Mode>('single');
  const [challengeMode, setChallengeMode] = useState<ChallengeMode>('spiral-abyss');
  const [singleEnemies, setSingleEnemies] = useState(DEFAULT_ENEMIES_SINGLE);
  const [singlePref, setSinglePref] = useState(() => t('advisor.defaultPreference'));
  const [leftEnemies, setLeftEnemies] = useState('abyss-mage');
  const [leftPref, setLeftPref] = useState(() => t('advisor.defaultPreference'));
  const [rightEnemies, setRightEnemies] = useState('ruin-guard');
  const [rightPref, setRightPref] = useState(() => t('advisor.defaultPreference'));
  const [diffSummary, setDiffSummary] = useState<string>('');
  const [run, setRun] = useState<RunState>({ kind: 'idle' });
  const [single, setSingle] = useState<SideState>(emptySideState());
  const [left, setLeft] = useState<SideState>(emptySideState());
  const [right, setRight] = useState<SideState>(emptySideState());

  const singleScrollRef = useRef<HTMLPreElement | null>(null);
  const leftScrollRef = useRef<HTMLPreElement | null>(null);
  const rightScrollRef = useRef<HTMLPreElement | null>(null);

  const handleEvent = useCallback((event: AdvisorEvent) => {
    const setter = event.side === 'left' ? setLeft : event.side === 'right' ? setRight : setSingle;
    switch (event.type) {
      case 'started':
        setRun({ kind: 'running' });
        setter(() => ({ stage: 'starting', message: '', streamText: '', result: null }));
        if (event.side === 'left') {
          setDiffSummary('');
          setRight(emptySideState());
        }
        break;
      case 'progress':
        setter((prev) => ({ ...prev, stage: event.stage, message: event.message ?? '' }));
        break;
      case 'delta':
        setter((prev) => ({ ...prev, streamText: prev.streamText + event.text }));
        break;
      case 'final':
        setter((prev) => ({
          ...prev,
          result: event.result,
          stage: event.result.source === 'llm' ? 'done' : 'done-fallback'
        }));
        if (event.side === 'single' || event.side === 'right') {
          setRun({ kind: 'idle' });
        }
        break;
      case 'cancelled':
        setter((prev) => ({ ...prev, stage: 'cancelled', message: '' }));
        setRun({ kind: 'cancelled' });
        break;
      case 'error':
        setter((prev) => ({ ...prev, stage: 'error', message: event.message }));
        setRun({ kind: 'error', message: event.message });
        break;
    }
  }, []);

  useEffect(() => {
    const unsubscribe = api.advisor.onEvent(handleEvent);
    return () => {
      unsubscribe();
    };
  }, [handleEvent]);

  useEffect(() => {
    autoscroll(singleScrollRef.current);
  }, [single.streamText]);
  useEffect(() => {
    autoscroll(leftScrollRef.current);
  }, [left.streamText]);
  useEffect(() => {
    autoscroll(rightScrollRef.current);
  }, [right.streamText]);

  async function handleSingleRun() {
    if (!activeUid) return;
    setSingle(emptySideState());
    const enemyNames = splitEnemies(singleEnemies);
    try {
      await api.advisor.recommend({
        uid: activeUid,
        enemyNames,
        preference: singlePref.trim() || undefined
      });
    } catch (error) {
      if (run.kind !== 'cancelled') {
        setRun({
          kind: 'error',
          message: localizeError(error, locale, t, 'advisor.error.recommend')
        });
      }
    }
  }

  async function handleCompareRun() {
    if (!activeUid) return;
    setLeft(emptySideState());
    setRight(emptySideState());
    setDiffSummary('');
    try {
      const result = await api.advisor.compare({
        uid: activeUid,
        left: {
          enemyNames: splitEnemies(leftEnemies),
          preference: leftPref.trim() || undefined
        },
        right: {
          enemyNames: splitEnemies(rightEnemies),
          preference: rightPref.trim() || undefined
        }
      });
      setDiffSummary(result.diffSummary);
    } catch (error) {
      if (run.kind !== 'cancelled') {
        setRun({
          kind: 'error',
          message: localizeError(error, locale, t, 'advisor.error.compare')
        });
      }
    }
  }

  async function handleCancel() {
    await api.advisor.cancel();
  }

  const isRunning = run.kind === 'running';

  if (!activeUid) {
    return (
      <section>
        <h2 className="gta-section-title">
          {t('advisor.title')}
          <span className="gta-section-sub">ADVISOR</span>
        </h2>
        <OrnamentPanel>
          <div className="gta-panel-body">
            <p className="gta-hint">{t('advisor.noUid')}</p>
            <div className="gta-actions">
              <GtaButton icon={<ButtonGlyph name="plus" />} onClick={onGotoOnboarding}>
                {t('advisor.gotoBind')}
              </GtaButton>
            </div>
          </div>
        </OrnamentPanel>
      </section>
    );
  }

  return (
    <section className="gta-advisor-page">
      <header className="gta-page-head">
        <div>
          <span className="gta-page-kicker">UID {activeUid}</span>
          <h2 className="gta-section-title">{t('advisor.chooseTitle')}</h2>
          <p className="gta-page-lead">{t('advisor.chooseHelp')}</p>
        </div>
      </header>

      <div className="gta-challenge-path" aria-label={t('advisor.chooseTitle')}>
        <ChallengeModeEntry
          mode="spiral-abyss"
          eyebrow={t('advisor.mode.abyss.eyebrow')}
          title={t('advisor.mode.abyss.title')}
          summary={t('advisor.mode.abyss.summary')}
          selected={challengeMode === 'spiral-abyss'}
          onSelect={setChallengeMode}
        />
        <ChallengeModeEntry
          mode="imaginarium-theater"
          eyebrow={t('advisor.mode.theater.eyebrow')}
          title={t('advisor.mode.theater.title')}
          summary={t('advisor.mode.theater.summary')}
          selected={challengeMode === 'imaginarium-theater'}
          onSelect={setChallengeMode}
        />
        <ChallengeModeEntry
          mode="stygian-onslaught"
          eyebrow={t('advisor.mode.stygian.eyebrow')}
          title={t('advisor.mode.stygian.title')}
          summary={t('advisor.mode.stygian.summary')}
          selected={challengeMode === 'stygian-onslaught'}
          onSelect={setChallengeMode}
        />
      </div>

      <div className="gta-mode-status" aria-live="polite">
        <span className="gta-mode-status-mark" aria-hidden="true">
          ✦
        </span>
        <span>
          <strong>
            {t('advisor.mode.selected', { mode: challengeModeLabel(challengeMode, t) })}
          </strong>
          {t('advisor.mode.pending')}
        </span>
      </div>

      <details className="gta-disclosure gta-advisor-advanced">
        <summary>{t('advisor.advanced')}</summary>
        <div className="gta-disclosure-body">
          <p className="gta-hint">{t('advisor.advancedHelp')}</p>
          <div className="gta-page-head gta-advisor-legacy-head">
            <h3 className="gta-card-title">{t('advisor.title')}</h3>
            <div className="gta-segment" role="group" aria-label={t('advisor.advancedModeLabel')}>
              <button
                type="button"
                className={mode === 'single' ? 'is-active' : ''}
                aria-pressed={mode === 'single'}
                onClick={() => setMode('single')}
              >
                {t('advisor.single')}
              </button>
              <button
                type="button"
                className={mode === 'compare' ? 'is-active' : ''}
                aria-pressed={mode === 'compare'}
                onClick={() => setMode('compare')}
              >
                {t('advisor.compare')}
              </button>
            </div>
          </div>

          {mode === 'single' && (
            <>
              <div className="gta-panel" style={{ marginBottom: 'var(--gta-s4)' }}>
                <div className="gta-panel-body">
                  <div className="gta-form">
                    <label className="gta-field">
                      <span className="gta-field-label">{t('advisor.enemiesCurrent')}</span>
                      <textarea
                        className="gta-textarea"
                        value={singleEnemies}
                        onChange={(event) => setSingleEnemies(event.target.value)}
                        spellCheck={false}
                        placeholder={t('advisor.enemiesPlaceholder')}
                      />
                    </label>
                    <label className="gta-field">
                      <span className="gta-field-label">{t('advisor.preferenceOptional')}</span>
                      <input
                        type="text"
                        className="gta-input"
                        value={singlePref}
                        onChange={(event) => setSinglePref(event.target.value)}
                      />
                    </label>
                    <div className="gta-actions">
                      <button
                        type="button"
                        className="gta-btn"
                        onClick={() => void handleSingleRun()}
                        disabled={isRunning}
                      >
                        <span className="gta-btn-icon">
                          <ButtonGlyph name="check" />
                        </span>
                        {isRunning ? t('advisor.generating') : t('advisor.generate')}
                      </button>
                      {isRunning && (
                        <button
                          type="button"
                          className="gta-btn gta-btn--danger"
                          onClick={() => void handleCancel()}
                        >
                          <span className="gta-btn-icon">
                            <ButtonGlyph name="x" />
                          </span>
                          {t('advisor.cancel')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <SidePanel
                title={t('advisor.singleResult')}
                sideState={single}
                scrollRef={singleScrollRef}
              />
            </>
          )}

          {mode === 'compare' && (
            <>
              <div className="gta-compare-grid" style={{ marginBottom: 'var(--gta-s4)' }}>
                <div className="gta-panel">
                  <div className="gta-panel-body">
                    <h3 className="gta-name" style={{ fontSize: 'var(--gta-text-lg)' }}>
                      {t('advisor.environmentA')}
                    </h3>
                    <div className="gta-form">
                      <label className="gta-field">
                        <span className="gta-field-label">{t('advisor.enemies')}</span>
                        <textarea
                          className="gta-textarea"
                          value={leftEnemies}
                          onChange={(event) => setLeftEnemies(event.target.value)}
                          spellCheck={false}
                        />
                      </label>
                      <label className="gta-field">
                        <span className="gta-field-label">{t('advisor.preference')}</span>
                        <input
                          type="text"
                          className="gta-input"
                          value={leftPref}
                          onChange={(event) => setLeftPref(event.target.value)}
                        />
                      </label>
                    </div>
                  </div>
                </div>
                <div className="gta-panel">
                  <div className="gta-panel-body">
                    <h3 className="gta-name" style={{ fontSize: 'var(--gta-text-lg)' }}>
                      {t('advisor.environmentB')}
                    </h3>
                    <div className="gta-form">
                      <label className="gta-field">
                        <span className="gta-field-label">{t('advisor.enemies')}</span>
                        <textarea
                          className="gta-textarea"
                          value={rightEnemies}
                          onChange={(event) => setRightEnemies(event.target.value)}
                          spellCheck={false}
                        />
                      </label>
                      <label className="gta-field">
                        <span className="gta-field-label">{t('advisor.preference')}</span>
                        <input
                          type="text"
                          className="gta-input"
                          value={rightPref}
                          onChange={(event) => setRightPref(event.target.value)}
                        />
                      </label>
                    </div>
                  </div>
                </div>
              </div>

              <div className="gta-actions" style={{ marginBottom: 'var(--gta-s4)' }}>
                <button
                  type="button"
                  className="gta-btn"
                  onClick={() => void handleCompareRun()}
                  disabled={isRunning}
                >
                  <span className="gta-btn-icon">
                    <ButtonGlyph name="check" />
                  </span>
                  {isRunning ? t('advisor.comparing') : t('advisor.generateCompare')}
                </button>
                {isRunning && (
                  <button
                    type="button"
                    className="gta-btn gta-btn--danger"
                    onClick={() => void handleCancel()}
                  >
                    <span className="gta-btn-icon">
                      <ButtonGlyph name="x" />
                    </span>
                    {t('advisor.cancel')}
                  </button>
                )}
              </div>

              {diffSummary && (
                <div className="gta-diff-summary" style={{ marginBottom: 'var(--gta-s4)' }}>
                  <span className="gta-team-line-label">{t('advisor.difference')}</span>
                  {diffSummary}
                </div>
              )}

              <div className="gta-compare-grid">
                <SidePanel
                  title={t('advisor.environmentA')}
                  sideState={left}
                  scrollRef={leftScrollRef}
                />
                <SidePanel
                  title={t('advisor.environmentB')}
                  sideState={right}
                  scrollRef={rightScrollRef}
                />
              </div>
            </>
          )}

          {run.kind === 'error' && run.message && (
            <p className="gta-error" style={{ marginTop: 'var(--gta-s4)' }}>
              {t('advisor.error.withMessage', {
                message:
                  locale === 'en-US' && /[\u3400-\u9fff]/u.test(run.message)
                    ? t('common.error.internal')
                    : run.message
              })}
            </p>
          )}
        </div>
      </details>
    </section>
  );
}

interface SidePanelProps {
  title: string;
  sideState: SideState;
  scrollRef: React.RefObject<HTMLPreElement | null>;
}

function SidePanel({ title, sideState, scrollRef }: SidePanelProps) {
  const { t } = useI18n();
  if (!sideState.stage && !sideState.result) {
    return null;
  }
  const isLlm = sideState.result?.source === 'llm';
  return (
    <div className="gta-panel">
      <div className="gta-panel-body">
        <div className="gta-page-head" style={{ marginBottom: 0 }}>
          <h3 className="gta-name" style={{ fontSize: 'var(--gta-text-lg)', margin: 0 }}>
            {title}
          </h3>
          {sideState.result && (
            <span className={isLlm ? 'gta-tag is-llm' : 'gta-tag is-fallback'}>
              {isLlm ? t('advisor.smartService') : t('advisor.localHeuristic')} ·{' '}
              {t('advisor.teamCount', { count: sideState.result.teams.length })}
            </span>
          )}
        </div>

        {sideState.stage && (
          <div className="gta-stream-wrap">
            <p className="gta-progress-line">
              <span style={{ color: 'var(--gta-text-on-light-faint)' }}>
                {progressLabel(sideState.stage, t)}
              </span>
            </p>
            {sideState.streamText && (
              <pre ref={scrollRef} className="gta-stream">
                {sideState.streamText}
              </pre>
            )}
          </div>
        )}

        {sideState.result && (
          <div className="gta-form">
            <p style={{ margin: 0 }}>{sideState.result.summary}</p>
            {sideState.result.dataNotes && sideState.result.dataNotes.length > 0 && (
              <p className="gta-hint" style={{ margin: 0 }}>
                {t('advisor.dataNotes', { notes: sideState.result.dataNotes.join('; ') })}
              </p>
            )}
            {sideState.result.teams.map((team, index) => (
              <article key={`${team.name}-${index}`} className="gta-team-card">
                <h4>
                  {team.name}
                  {team.confidence && (
                    <span className="gta-tag" style={{ marginLeft: 8 }}>
                      {t('advisor.confidence', { level: confidenceLabel(team.confidence, t) })}
                    </span>
                  )}
                </h4>
                <p className="gta-team-roster">
                  {team.characters
                    .map((character) => `${character.name}(${character.element})`)
                    .join(' · ')}
                </p>
                <p>
                  <span className="gta-team-line-label">{t('advisor.reasoning')}</span>
                  {team.reasoning}
                </p>
                <p>
                  <span className="gta-team-line-label">{t('advisor.rotation')}</span>
                  {team.rotationTip}
                </p>
                {team.assumptions && team.assumptions.length > 0 && (
                  <p className="gta-hint">
                    <span className="gta-team-line-label">{t('advisor.assumptions')}</span>
                    {team.assumptions.join('; ')}
                  </p>
                )}
                {team.critiqueIssues && team.critiqueIssues.length > 0 && (
                  <p className="gta-hint">
                    <span className="gta-team-line-label">{t('advisor.risks')}</span>
                    {team.critiqueIssues.join('; ')}
                  </p>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function confidenceLabel(
  confidence: 'low' | 'medium' | 'high',
  t: ReturnType<typeof useI18n>['t']
): string {
  return {
    low: t('advisor.confidence.low'),
    medium: t('advisor.confidence.medium'),
    high: t('advisor.confidence.high')
  }[confidence];
}

function progressLabel(stage: string, t: ReturnType<typeof useI18n>['t']): string {
  const labels: Record<string, string> = {
    starting: t('advisor.progress.starting'),
    analyzing: t('advisor.progress.analyzing'),
    'data-curator': t('advisor.progress.data-curator'),
    'team-composer': t('advisor.progress.team-composer'),
    critique: t('advisor.progress.critique'),
    'rotation-coach': t('advisor.progress.rotation-coach'),
    explain: t('advisor.progress.explain'),
    'fallback-characters': t('advisor.progress.fallback-characters'),
    'fallback-key': t('advisor.progress.fallback-key'),
    'fallback-error': t('advisor.progress.fallback-error'),
    done: t('advisor.progress.done'),
    'done-fallback': t('advisor.progress.done-fallback'),
    cancelled: t('advisor.progress.cancelled')
  };
  return labels[stage] ?? t('advisor.progress.working');
}

function autoscroll(el: HTMLPreElement | null) {
  if (el) {
    el.scrollTop = el.scrollHeight;
  }
}

function splitEnemies(input: string): string[] {
  return input
    .split(/[\n,，]/g)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function challengeModeLabel(mode: ChallengeMode, t: ReturnType<typeof useI18n>['t']): string {
  return {
    'spiral-abyss': t('advisor.mode.abyss.title'),
    'imaginarium-theater': t('advisor.mode.theater.title'),
    'stygian-onslaught': t('advisor.mode.stygian.title')
  }[mode];
}
