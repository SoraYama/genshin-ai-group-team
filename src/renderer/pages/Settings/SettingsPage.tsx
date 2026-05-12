import { useEffect, useState } from 'react';
import { api } from '../../ipc';
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../../../shared/domain';
import type { LlmHealthReport, PublicConfig } from '../../../shared/domain';
import { ButtonGlyph } from '../../design/Icons';

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

type TestStatus =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; report: LlmHealthReport }
  | { kind: 'error'; message: string };

export function SettingsPage() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: 'idle' });

  async function refresh() {
    const next = await api.config.getPublic();
    setConfig(next);
    setBaseUrl(next.llm.baseUrl);
    setModel(next.llm.model);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleSave() {
    setSaveStatus({ kind: 'saving' });
    try {
      const trimmedKey = apiKey.trim();
      await api.config.setLlm({
        apiKey: trimmedKey.length > 0 ? trimmedKey : undefined,
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim() || undefined
      });
      setApiKey('');
      setSaveStatus({ kind: 'saved' });
      await refresh();
    } catch (error) {
      setSaveStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async function handleTest() {
    setTestStatus({ kind: 'running' });
    try {
      const report = await api.config.testLlm();
      setTestStatus({ kind: 'done', report });
    } catch (error) {
      setTestStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  async function handleClear() {
    await api.config.clearLlm();
    setApiKey('');
    setSaveStatus({ kind: 'idle' });
    setTestStatus({ kind: 'idle' });
    await refresh();
  }

  if (!config) {
    return <p className="gta-hint gta-on-bg">Loading…</p>;
  }

  return (
    <section>
      <h2 className="gta-section-title">
        LLM 配置
        <span className="gta-section-sub">SETTINGS</span>
      </h2>

      <div className="gta-panel" style={{ marginBottom: 'var(--gta-s4)' }}>
        <div className="gta-panel-body">
          <p className="gta-hint">
            本地保存。API Key 通过系统钥匙串加密落盘。仅在&ldquo;测试连接&rdquo;或推荐生成时才会发往你配置的
            base URL。
          </p>
          <dl className="gta-status-grid">
            <div>
              <dt>API Key</dt>
              <dd>{config.llm.hasApiKey ? '已配置（加密）' : '未配置'}</dd>
            </div>
            <div>
              <dt>Base URL</dt>
              <dd>{config.llm.baseUrl}</dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{config.llm.model}</dd>
            </div>
            <div>
              <dt>App Version</dt>
              <dd>{config.appVersion}</dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="gta-panel">
        <div className="gta-panel-body">
          <form
            className="gta-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSave();
            }}
          >
            <div className="gta-form-grid">
              <label className="gta-field">
                <span className="gta-field-label">API Key</span>
                <input
                  type="password"
                  className="gta-input is-mono"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={config.llm.hasApiKey ? '已存在 Key — 留空则不修改' : 'sk-ant-...'}
                  autoComplete="off"
                />
              </label>

              <label className="gta-field">
                <span className="gta-field-label">Base URL</span>
                <input
                  type="url"
                  className="gta-input is-mono"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder={DEFAULT_BASE_URL}
                />
              </label>

              <label className="gta-field">
                <span className="gta-field-label">Model</span>
                <input
                  type="text"
                  className="gta-input is-mono"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder={DEFAULT_MODEL}
                />
              </label>
            </div>

            <div className="gta-actions">
              <button
                type="submit"
                className="gta-btn"
                disabled={
                  saveStatus.kind === 'saving' ||
                  (!config.llm.hasApiKey && apiKey.trim().length === 0)
                }
              >
                <span className="gta-btn-icon">
                  <ButtonGlyph name="check" />
                </span>
                {saveStatus.kind === 'saving' ? '保存中…' : '保存配置'}
              </button>
              <button
                type="button"
                className="gta-btn gta-btn--ghost"
                onClick={() => void handleTest()}
                disabled={testStatus.kind === 'running' || !config.llm.hasApiKey}
              >
                {testStatus.kind === 'running' ? '测试中…' : '测试连接'}
              </button>
              <button
                type="button"
                className="gta-btn gta-btn--danger"
                onClick={() => void handleClear()}
                disabled={!config.llm.hasApiKey}
              >
                <span className="gta-btn-icon">
                  <ButtonGlyph name="trash" />
                </span>
                清除 Key
              </button>
            </div>

            {saveStatus.kind === 'saved' && <p className="gta-ok">配置已保存。</p>}
            {saveStatus.kind === 'error' && (
              <p className="gta-error">保存失败：{saveStatus.message}</p>
            )}

            {testStatus.kind === 'done' && (
              <div className={testStatus.report.ok ? 'gta-ok' : 'gta-error'}>
                <p style={{ margin: 0 }}>
                  {testStatus.report.ok ? '✓ 连接正常' : '✗ 连接失败'} ·{' '}
                  {testStatus.report.latencyMs}ms
                  {testStatus.report.httpStatus !== undefined &&
                    ` · HTTP ${testStatus.report.httpStatus}`}
                </p>
                {testStatus.report.message && (
                  <pre
                    style={{
                      margin: 'var(--gta-s2) 0 0',
                      fontFamily: 'var(--gta-font-mono)',
                      fontSize: 'var(--gta-text-xs)',
                      whiteSpace: 'pre-wrap'
                    }}
                  >
                    {testStatus.report.message}
                  </pre>
                )}
              </div>
            )}
            {testStatus.kind === 'error' && (
              <p className="gta-error">测试请求失败：{testStatus.message}</p>
            )}
          </form>
        </div>
      </div>
    </section>
  );
}
