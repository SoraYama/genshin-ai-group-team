import { useEffect, useRef, useState } from 'react';
import { api } from '../../ipc';
import type {
  AdvisorEvent,
  AdvisorSide,
  ProfileStateView,
  RecommendationResult
} from '../../../shared/domain';
import { ButtonGlyph } from '../../design/Icons';

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
const DEFAULT_PREF = '操作简单、容错高';

function emptySideState(): SideState {
  return { stage: '', message: '', streamText: '', result: null };
}

export function AdvisorPage({ state, onGotoOnboarding }: AdvisorPageProps) {
  const activeUid = state.activeUid;
  const [mode, setMode] = useState<Mode>('single');
  const [singleEnemies, setSingleEnemies] = useState(DEFAULT_ENEMIES_SINGLE);
  const [singlePref, setSinglePref] = useState(DEFAULT_PREF);
  const [leftEnemies, setLeftEnemies] = useState('abyss-mage');
  const [leftPref, setLeftPref] = useState(DEFAULT_PREF);
  const [rightEnemies, setRightEnemies] = useState('ruin-guard');
  const [rightPref, setRightPref] = useState(DEFAULT_PREF);
  const [diffSummary, setDiffSummary] = useState<string>('');
  const [run, setRun] = useState<RunState>({ kind: 'idle' });
  const [single, setSingle] = useState<SideState>(emptySideState());
  const [left, setLeft] = useState<SideState>(emptySideState());
  const [right, setRight] = useState<SideState>(emptySideState());

  const singleScrollRef = useRef<HTMLPreElement | null>(null);
  const leftScrollRef = useRef<HTMLPreElement | null>(null);
  const rightScrollRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    const unsubscribe = api.advisor.onEvent(handleEvent);
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    autoscroll(singleScrollRef.current);
  }, [single.streamText]);
  useEffect(() => {
    autoscroll(leftScrollRef.current);
  }, [left.streamText]);
  useEffect(() => {
    autoscroll(rightScrollRef.current);
  }, [right.streamText]);

  function handleEvent(event: AdvisorEvent) {
    const setter = getSetterForSide(event.side);
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
  }

  function getSetterForSide(side: AdvisorSide) {
    if (side === 'left') return setLeft;
    if (side === 'right') return setRight;
    return setSingle;
  }

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
          message: error instanceof Error ? error.message : '推荐请求失败'
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
          message: error instanceof Error ? error.message : '对比请求失败'
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
          AI 配队推荐
          <span className="gta-section-sub">ADVISOR</span>
        </h2>
        <div className="gta-panel">
          <div className="gta-panel-body">
            <p className="gta-hint">还没有绑定 UID。先去绑定一个账号再来生成推荐。</p>
            <div className="gta-actions">
              <button type="button" className="gta-btn" onClick={onGotoOnboarding}>
                <span className="gta-btn-icon">
                  <ButtonGlyph name="plus" />
                </span>
                去绑定
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="gta-page-head">
        <h2 className="gta-section-title">
          AI 配队推荐
          <span className="gta-section-sub">UID {activeUid}</span>
        </h2>
        <div className="gta-segment">
          <button
            type="button"
            className={mode === 'single' ? 'is-active' : ''}
            onClick={() => setMode('single')}
          >
            单环境
          </button>
          <button
            type="button"
            className={mode === 'compare' ? 'is-active' : ''}
            onClick={() => setMode('compare')}
          >
            双环境对比
          </button>
        </div>
      </div>

      {mode === 'single' && (
        <>
          <div className="gta-panel" style={{ marginBottom: 'var(--gta-s4)' }}>
            <div className="gta-panel-body">
              <div className="gta-form">
                <label className="gta-field">
                  <span className="gta-field-label">本期敌人</span>
                  <textarea
                    className="gta-textarea"
                    value={singleEnemies}
                    onChange={(event) => setSingleEnemies(event.target.value)}
                    spellCheck={false}
                    placeholder="多个敌人用逗号或换行分隔"
                  />
                </label>
                <label className="gta-field">
                  <span className="gta-field-label">偏好（可选）</span>
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
                    {isRunning ? '推荐生成中…' : 'AI 推荐'}
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
                      取消
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          <SidePanel title="单环境结果" sideState={single} scrollRef={singleScrollRef} />
        </>
      )}

      {mode === 'compare' && (
        <>
          <div className="gta-compare-grid" style={{ marginBottom: 'var(--gta-s4)' }}>
            <div className="gta-panel">
              <div className="gta-panel-body">
                <h3 className="gta-name" style={{ fontSize: 'var(--gta-text-lg)' }}>
                  环境 A
                </h3>
                <div className="gta-form">
                  <label className="gta-field">
                    <span className="gta-field-label">敌人</span>
                    <textarea
                      className="gta-textarea"
                      value={leftEnemies}
                      onChange={(event) => setLeftEnemies(event.target.value)}
                      spellCheck={false}
                    />
                  </label>
                  <label className="gta-field">
                    <span className="gta-field-label">偏好</span>
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
                  环境 B
                </h3>
                <div className="gta-form">
                  <label className="gta-field">
                    <span className="gta-field-label">敌人</span>
                    <textarea
                      className="gta-textarea"
                      value={rightEnemies}
                      onChange={(event) => setRightEnemies(event.target.value)}
                      spellCheck={false}
                    />
                  </label>
                  <label className="gta-field">
                    <span className="gta-field-label">偏好</span>
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
              {isRunning ? '对比生成中…' : '生成双环境对比'}
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
                取消
              </button>
            )}
          </div>

          {diffSummary && (
            <div className="gta-diff-summary" style={{ marginBottom: 'var(--gta-s4)' }}>
              <span className="gta-team-line-label">差异</span>
              {diffSummary}
            </div>
          )}

          <div className="gta-compare-grid">
            <SidePanel title="环境 A" sideState={left} scrollRef={leftScrollRef} />
            <SidePanel title="环境 B" sideState={right} scrollRef={rightScrollRef} />
          </div>
        </>
      )}

      {run.kind === 'error' && run.message && (
        <p className="gta-error" style={{ marginTop: 'var(--gta-s4)' }}>
          推荐请求失败：{run.message}
        </p>
      )}
    </section>
  );
}

interface SidePanelProps {
  title: string;
  sideState: SideState;
  scrollRef: React.RefObject<HTMLPreElement | null>;
}

function SidePanel({ title, sideState, scrollRef }: SidePanelProps) {
  if (!sideState.stage && !sideState.result) {
    return null;
  }
  const isLlm = sideState.result?.source === 'llm';
  return (
    <div className="gta-panel">
      <div className="gta-panel-body">
        <div className="gta-page-head" style={{ marginBottom: 0 }}>
          <h3
            className="gta-name"
            style={{ fontSize: 'var(--gta-text-lg)', margin: 0 }}
          >
            {title}
          </h3>
          {sideState.result && (
            <span className={isLlm ? 'gta-tag is-llm' : 'gta-tag is-fallback'}>
              {isLlm ? 'LLM' : '本地启发式'} · {sideState.result.teams.length} 套
            </span>
          )}
        </div>

        {sideState.stage && (
          <div className="gta-stream-wrap">
            <p className="gta-progress-line">
              <span className="gta-team-line-label">阶段</span>
              <code>{sideState.stage}</code>
              {sideState.message && (
                <span style={{ color: 'var(--gta-text-on-light-faint)' }}>
                  · {sideState.message}
                </span>
              )}
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
            {sideState.result.teams.map((team, index) => (
              <article key={`${team.name}-${index}`} className="gta-team-card">
                <h4>{team.name}</h4>
                <p className="gta-team-roster">
                  {team.characters
                    .map((character) => `${character.name}(${character.element})`)
                    .join(' · ')}
                </p>
                <p>
                  <span className="gta-team-line-label">思路</span>
                  {team.reasoning}
                </p>
                <p>
                  <span className="gta-team-line-label">手法</span>
                  {team.rotationTip}
                </p>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
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
