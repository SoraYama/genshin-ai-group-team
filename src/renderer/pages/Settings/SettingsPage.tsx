import { useEffect, useState } from 'react';
import { api } from '../../ipc';
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../../../shared/domain';
import type { LlmHealthReport, PublicConfig } from '../../../shared/domain';

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
    return <p>Loading…</p>;
  }

  return (
    <section className="settings-page">
      <h2>LLM 配置</h2>
      <p className="hint">
        本地保存。API Key 会通过系统钥匙串加密。仅在你点 &ldquo;测试连接&rdquo; 或后续推荐时才会发往你配置的 base URL。
      </p>

      <dl className="status-grid">
        <div>
          <dt>API Key</dt>
          <dd>{config.llm.hasApiKey ? '已配置（加密存储）' : '未配置'}</dd>
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

      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSave();
        }}
      >
        <label>
          API Key
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={config.llm.hasApiKey ? '已存在 Key — 留空则不修改' : 'sk-ant-...'}
            autoComplete="off"
          />
        </label>

        <label>
          Base URL
          <input
            type="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={DEFAULT_BASE_URL}
          />
        </label>

        <label>
          Model
          <input
            type="text"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={DEFAULT_MODEL}
          />
        </label>

        <div className="button-row">
          <button
            type="submit"
            disabled={
              saveStatus.kind === 'saving' ||
              (!config.llm.hasApiKey && apiKey.trim().length === 0)
            }
          >
            {saveStatus.kind === 'saving' ? '保存中…' : '保存配置'}
          </button>
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={testStatus.kind === 'running' || !config.llm.hasApiKey}
          >
            {testStatus.kind === 'running' ? '测试中…' : '测试连接'}
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => void handleClear()}
            disabled={!config.llm.hasApiKey}
          >
            清除 Key
          </button>
        </div>
      </form>

      {saveStatus.kind === 'saved' && <p className="ok">配置已保存。</p>}
      {saveStatus.kind === 'error' && <p className="error">保存失败：{saveStatus.message}</p>}

      {testStatus.kind === 'done' && (
        <div className={testStatus.report.ok ? 'ok' : 'error'}>
          <p>
            {testStatus.report.ok ? '连接正常' : '连接失败'} · {testStatus.report.latencyMs}ms
            {testStatus.report.httpStatus !== undefined && ` · HTTP ${testStatus.report.httpStatus}`}
          </p>
          {testStatus.report.message && <pre>{testStatus.report.message}</pre>}
        </div>
      )}
      {testStatus.kind === 'error' && <p className="error">测试请求失败：{testStatus.message}</p>}
    </section>
  );
}
