import { useEffect, useRef, useState, type RefObject } from 'react';

import type { AgentRunTrace, AgentStageTrace } from '../../../../shared/agent-run-trace';
import { sourceBadge, type PresentationLocale } from '../abyss-presentation';
import './agent-trace-drawer.css';

interface AgentTraceDrawerProps {
  open: boolean;
  loading: boolean;
  failedToLoad: boolean;
  trace: AgentRunTrace | null;
  locale: PresentationLocale;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

export function AgentTraceDrawer({
  open,
  loading,
  failedToLoad,
  trace,
  locale,
  returnFocusRef,
  onClose
}: AgentTraceDrawerProps) {
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);
  const isEnglish = locale === 'en';

  useEffect(() => {
    if (!open) {
      if (wasOpen.current) returnFocusRef.current?.focus();
      wasOpen.current = false;
      return;
    }
    wasOpen.current = true;
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), summary, [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable || focusable.length === 0) {
        event.preventDefault();
        drawerRef.current?.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, open, returnFocusRef]);

  if (!open) return null;

  return (
    <div className="agent-trace-layer">
      <button
        className="agent-trace-backdrop"
        type="button"
        tabIndex={-1}
        aria-label={isEnglish ? 'Close model run record' : '关闭模型运行记录'}
        onClick={onClose}
      />
      <aside
        ref={drawerRef}
        className="agent-trace-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-trace-title"
        tabIndex={-1}
      >
        <header>
          <div>
            <span>{isEnglish ? 'Run diagnostics' : '运行诊断'}</span>
            <h2 id="agent-trace-title">{isEnglish ? 'Model run record' : '模型运行记录'}</h2>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose}>
            {isEnglish ? 'Close' : '关闭'}
          </button>
        </header>

        <div className="agent-trace-body">
          {loading ? (
            <p>{isEnglish ? 'Loading the latest run…' : '正在读取最近一次运行…'}</p>
          ) : failedToLoad ? (
            <p role="alert">
              {isEnglish ? 'The run record could not be loaded.' : '无法读取模型运行记录。'}
            </p>
          ) : trace === null ? (
            <div className="agent-trace-empty">
              <strong>{isEnglish ? 'No model run yet' : '尚未运行模型'}</strong>
              <p>
                {isEnglish
                  ? 'Generate a plan first, then open this record.'
                  : '生成一次方案后，可在这里查看模型与本地阶段记录。'}
              </p>
            </div>
          ) : (
            <TraceContents trace={trace} locale={locale} />
          )}
        </div>
      </aside>
    </div>
  );
}

function TraceContents({ trace, locale }: { trace: AgentRunTrace; locale: PresentationLocale }) {
  const isEnglish = locale === 'en';
  const usageTotal = trace.usage.inputTokens + trace.usage.outputTokens;
  const elapsed =
    trace.status === 'running'
      ? null
      : Math.max(0, Date.parse(trace.finishedAt) - Date.parse(trace.startedAt));
  return (
    <>
      <dl className="agent-trace-summary">
        <div>
          <dt>{isEnglish ? 'Model' : '模型'}</dt>
          <dd>{trace.model}</dd>
        </div>
        <div>
          <dt>{isEnglish ? 'Started' : '开始'}</dt>
          <dd>{formatTime(trace.startedAt, locale)}</dd>
        </div>
        <div>
          <dt>{isEnglish ? 'Finished' : '结束'}</dt>
          <dd>
            {trace.status === 'running'
              ? isEnglish
                ? 'Running'
                : '运行中'
              : formatTime(trace.finishedAt, locale)}
          </dd>
        </div>
        <div>
          <dt>{isEnglish ? 'Final source' : '最终来源'}</dt>
          <dd>{trace.finalSource ? sourceBadge(trace.finalSource, locale) : '—'}</dd>
        </div>
        <div>
          <dt>Token</dt>
          <dd>
            {usageTotal} ({trace.usage.inputTokens}↓ / {trace.usage.outputTokens}↑)
          </dd>
        </div>
        <div>
          <dt>{isEnglish ? 'Duration' : '耗时'}</dt>
          <dd>{elapsed === null ? '—' : formatDuration(elapsed)}</dd>
        </div>
      </dl>

      {trace.failure && (
        <p className="agent-trace-failure" role="alert">
          <strong>{isEnglish ? 'Error' : '错误'}</strong>
          {trace.failure.code}: {trace.failure.message}
        </p>
      )}

      <div className="agent-trace-stages">
        {trace.stages.map((stage, index) => (
          <StageDetails
            key={`${stage.stage}-${index}`}
            stage={stage}
            locale={locale}
            defaultOpen={index === 0}
          />
        ))}
      </div>
    </>
  );
}

function StageDetails({
  stage,
  locale,
  defaultOpen
}: {
  stage: AgentStageTrace;
  locale: PresentationLocale;
  defaultOpen: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const isEnglish = locale === 'en';
  const raw = stage.rawOutput ?? stage.inputSummary ?? '';

  async function copyRaw() {
    if (!raw) return;
    await navigator.clipboard.writeText(raw);
    setCopied(true);
  }

  return (
    <details open={defaultOpen}>
      <summary>
        <span>{stage.stage}</span>
        <strong>{stage.status}</strong>
        <small>{stage.durationMs === undefined ? '—' : formatDuration(stage.durationMs)}</small>
      </summary>
      <dl>
        <div>
          <dt>{isEnglish ? 'Status' : '状态'}</dt>
          <dd>{stage.status}</dd>
        </div>
        <div>
          <dt>{isEnglish ? 'Duration' : '耗时'}</dt>
          <dd>{stage.durationMs === undefined ? '—' : formatDuration(stage.durationMs)}</dd>
        </div>
        <div>
          <dt>{isEnglish ? 'Tools' : '工具'}</dt>
          <dd>
            {stage.tools.length === 0
              ? isEnglish
                ? 'None'
                : '无'
              : stage.tools.map(({ name, status }) => `${name} · ${status}`).join('；')}
          </dd>
        </div>
        <div>
          <dt>{isEnglish ? 'Citations' : '引用'}</dt>
          <dd>{stage.citationIds.join('；') || (isEnglish ? 'None' : '无')}</dd>
        </div>
        <div>
          <dt>Token</dt>
          <dd>
            {stage.usage.inputTokens + stage.usage.outputTokens} ({stage.usage.inputTokens}↓ /{' '}
            {stage.usage.outputTokens}↑)
          </dd>
        </div>
        <div>
          <dt>{isEnglish ? 'Error' : '错误'}</dt>
          <dd>{stage.failure ? `${stage.failure.code}: ${stage.failure.message}` : '—'}</dd>
        </div>
      </dl>
      <div className="agent-trace-raw">
        <div>
          <strong>{isEnglish ? 'Raw output' : '原文'}</strong>
          <button type="button" disabled={!raw} onClick={() => void copyRaw()}>
            {copied ? (isEnglish ? 'Copied' : '已复制') : isEnglish ? 'Copy' : '复制'}
          </button>
        </div>
        <pre>{raw || (isEnglish ? 'No raw text recorded.' : '未记录原文。')}</pre>
      </div>
      {(stage.truncated ||
        stage.rawMessagesSummary?.truncated ||
        stage.webSearchEvidence?.truncated ||
        stage.tools.some(({ truncated }) => truncated)) && (
        <p className="agent-trace-truncated">
          {isEnglish
            ? 'This record was truncated to stay within the local storage limit.'
            : '记录已按本地容量上限截断。'}
        </p>
      )}
    </details>
  );
}

function formatTime(value: string, locale: PresentationLocale): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

function formatDuration(value: number): string {
  return value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(2)}s`;
}
