import { useEffect, useRef, useState } from 'react';
import { api } from '../../ipc';
import type {
  AdvisorEvent,
  AdvisorSide,
  ProfileStateView,
  RecommendationResult
} from '../../../shared/domain';

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
        if (event.side === 'left' || event.side === 'right') {
          // 对比开始时清空对面侧（防止上一次残留）
          if (event.side === 'left') {
            setDiffSummary('');
            setRight(emptySideState());
          }
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
      <section className="advisor-page">
        <p className="hint">还没有绑定 UID。先去绑定一个账号再来生成推荐。</p>
        <button type="button" onClick={onGotoOnboarding}>
          去绑定
        </button>
      </section>
    );
  }

  return (
    <section className="advisor-page">
      <header className="advisor-header">
        <div>
          <h2>AI 配队推荐</h2>
          <p className="hint">基于当前 UID {activeUid} 的角色面板，调用你配置的 LLM 生成推荐。</p>
        </div>
        <div className="mode-switch">
          <button
            type="button"
            className={mode === 'single' ? 'nav-active' : ''}
            onClick={() => setMode('single')}
          >
            单环境
          </button>
          <button
            type="button"
            className={mode === 'compare' ? 'nav-active' : ''}
            onClick={() => setMode('compare')}
          >
            双环境对比
          </button>
        </div>
      </header>

      {mode === 'single' && (
        <>
          <div className="advisor-form">
            <label>
              本期敌人
              <textarea
                value={singleEnemies}
                onChange={(event) => setSingleEnemies(event.target.value)}
                spellCheck={false}
              />
            </label>
            <label>
              偏好（可选）
              <input
                type="text"
                value={singlePref}
                onChange={(event) => setSinglePref(event.target.value)}
              />
            </label>
            <div className="button-row">
              <button type="button" onClick={() => void handleSingleRun()} disabled={isRunning}>
                {isRunning ? '推荐生成中…' : 'AI 推荐'}
              </button>
              {isRunning && (
                <button type="button" className="danger" onClick={() => void handleCancel()}>
                  取消
                </button>
              )}
            </div>
          </div>

          <SidePanel
            title="单环境结果"
            sideState={single}
            scrollRef={singleScrollRef}
          />
        </>
      )}

      {mode === 'compare' && (
        <>
          <div className="compare-grid">
            <div className="advisor-form">
              <h3>环境 A</h3>
              <label>
                敌人
                <textarea
                  value={leftEnemies}
                  onChange={(event) => setLeftEnemies(event.target.value)}
                  spellCheck={false}
                />
              </label>
              <label>
                偏好
                <input
                  type="text"
                  value={leftPref}
                  onChange={(event) => setLeftPref(event.target.value)}
                />
              </label>
            </div>
            <div className="advisor-form">
              <h3>环境 B</h3>
              <label>
                敌人
                <textarea
                  value={rightEnemies}
                  onChange={(event) => setRightEnemies(event.target.value)}
                  spellCheck={false}
                />
              </label>
              <label>
                偏好
                <input
                  type="text"
                  value={rightPref}
                  onChange={(event) => setRightPref(event.target.value)}
                />
              </label>
            </div>
          </div>

          <div className="button-row">
            <button type="button" onClick={() => void handleCompareRun()} disabled={isRunning}>
              {isRunning ? '对比生成中…' : '生成双环境对比'}
            </button>
            {isRunning && (
              <button type="button" className="danger" onClick={() => void handleCancel()}>
                取消
              </button>
            )}
          </div>

          {diffSummary && (
            <div className="diff-summary">
              <span className="muted">差异：</span>
              {diffSummary}
            </div>
          )}

          <div className="compare-grid">
            <SidePanel title="环境 A" sideState={left} scrollRef={leftScrollRef} />
            <SidePanel title="环境 B" sideState={right} scrollRef={rightScrollRef} />
          </div>
        </>
      )}

      {run.kind === 'error' && run.message && (
        <p className="error">推荐请求失败：{run.message}</p>
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
  return (
    <div className="side-panel">
      <h3 className="side-panel-title">{title}</h3>
      {sideState.stage && (
        <div className="advisor-progress">
          <p>
            <span className="muted">阶段：</span>
            <code>{sideState.stage}</code>
            {sideState.message && <span className="muted"> · {sideState.message}</span>}
          </p>
          {sideState.streamText && (
            <pre ref={scrollRef} className="advisor-stream">
              {sideState.streamText}
            </pre>
          )}
        </div>
      )}
      {sideState.result && (
        <div className="advisor-result">
          <h4>
            {sideState.result.source === 'llm' ? 'LLM 推荐' : '本地启发式'} · {sideState.result.teams.length} 套
          </h4>
          <p>{sideState.result.summary}</p>
          {sideState.result.teams.map((team, index) => (
            <article key={`${team.name}-${index}`} className="team-card">
              <h4>{team.name}</h4>
              <p className="muted">
                {team.characters.map((character) => `${character.name}(${character.element})`).join(' · ')}
              </p>
              <p>
                <span className="muted">思路：</span>
                {team.reasoning}
              </p>
              <p>
                <span className="muted">手法：</span>
                {team.rotationTip}
              </p>
            </article>
          ))}
        </div>
      )}
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
