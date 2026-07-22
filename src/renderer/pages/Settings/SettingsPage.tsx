import { useEffect, useState } from 'react';
import { api } from '../../ipc';
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../../../shared/domain';
import type { LlmHealthReport, PublicConfig, UpdateStatus } from '../../../shared/domain';
import { ButtonGlyph } from '../../design/Icons';
import { localizeError, useI18n } from '../../i18n';
import { StatusStrip } from '../../components/ui/StatusStrip';

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
  const { locale, t } = useI18n();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [customHeadersText, setCustomHeadersText] = useState('');
  const [replaceCustomHeaders, setReplaceCustomHeaders] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: 'idle' });
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateActionError, setUpdateActionError] = useState('');

  async function refresh() {
    const next = await api.config.getPublic();
    setConfig(next);
    setBaseUrl(next.llm.baseUrl);
    setModel(next.llm.model);
  }

  useEffect(() => {
    void refresh();
    const unsubscribe = api.update.onEvent(setUpdateStatus);
    void api.update.getState().then(setUpdateStatus);
    return unsubscribe;
  }, []);

  async function runUpdateAction(action: 'check' | 'download' | 'install') {
    setUpdateActionError('');
    try {
      await api.update[action]();
    } catch (error) {
      setUpdateActionError(localizeError(error, locale, t, 'common.error.unknown'));
    }
  }

  async function handleSave() {
    setSaveStatus({ kind: 'saving' });
    try {
      const trimmedKey = apiKey.trim();
      await api.config.setLlm({
        apiKey: trimmedKey.length > 0 ? trimmedKey : undefined,
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim() || undefined,
        customHeaders: replaceCustomHeaders
          ? parseCustomHeaders(customHeadersText, t('settings.headers.invalid'))
          : undefined
      });
      setApiKey('');
      setCustomHeadersText('');
      setReplaceCustomHeaders(false);
      setSaveStatus({ kind: 'saved' });
      await refresh();
    } catch (error) {
      setSaveStatus({
        kind: 'error',
        message: localizeError(error, locale, t, 'common.error.unknown')
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
        message: localizeError(error, locale, t, 'common.error.unknown')
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
    return <p className="gta-hint gta-on-bg">{t('common.loading')}</p>;
  }

  return (
    <section>
      <h2 className="gta-section-title">
        {t('settings.title')}
        <span className="gta-section-sub">SETTINGS</span>
      </h2>

      <div className="gta-panel" style={{ marginBottom: 'var(--gta-s4)' }}>
        <div className="gta-panel-body">
          <p className="gta-hint">{t('settings.privacy')}</p>
          <StatusStrip
            items={[
              {
                label: 'API Key',
                value: config.llm.hasApiKey
                  ? t('settings.key.configured')
                  : t('settings.key.missing')
              },
              { label: 'Base URL', value: config.llm.baseUrl },
              { label: 'Model', value: config.llm.model },
              {
                label: t('settings.headers'),
                value:
                  config.llm.customHeaderKeys.length > 0
                    ? t('settings.headers.configured', {
                        keys: config.llm.customHeaderKeys.join(', ')
                      })
                    : t('settings.headers.none')
              },
              { label: 'App Version', value: config.appVersion },
              {
                label: t('settings.usage'),
                value: `${config.monthlyUsage.inputTokens.toLocaleString()} in / ${config.monthlyUsage.outputTokens.toLocaleString()} out`
              },
              {
                label: t('settings.cost'),
                value: `$${config.monthlyUsage.estimatedCostUsd.toFixed(4)}`
              }
            ]}
          />
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
                  placeholder={config.llm.hasApiKey ? t('settings.key.placeholder') : 'sk-ant-...'}
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

            <label className="gta-field">
              <span className="gta-field-label">{t('settings.headers')}</span>
              <textarea
                className="gta-textarea is-mono"
                aria-label={t('settings.headers')}
                value={customHeadersText}
                onChange={(event) => setCustomHeadersText(event.target.value)}
                placeholder={t('settings.headers.placeholder')}
                rows={3}
                spellCheck={false}
                autoComplete="off"
                disabled={!replaceCustomHeaders}
              />
              <span className="gta-hint">{t('settings.headers.help')}</span>
            </label>
            <label className="gta-checkbox-row">
              <input
                type="checkbox"
                checked={replaceCustomHeaders}
                onChange={(event) => setReplaceCustomHeaders(event.target.checked)}
              />
              <span>{t('settings.headers.replace')}</span>
            </label>

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
                {saveStatus.kind === 'saving' ? t('settings.saving') : t('settings.save')}
              </button>
              <button
                type="button"
                className="gta-btn gta-btn--ghost"
                onClick={() => void handleTest()}
                disabled={testStatus.kind === 'running' || !config.llm.hasApiKey}
              >
                {testStatus.kind === 'running' ? t('settings.testing') : t('settings.test')}
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
                {t('settings.clear')}
              </button>
            </div>

            {saveStatus.kind === 'saved' && <p className="gta-ok">{t('settings.saved')}</p>}
            {saveStatus.kind === 'error' && (
              <p className="gta-error">
                {t('settings.saveFailed', { message: saveStatus.message })}
              </p>
            )}

            {testStatus.kind === 'done' && (
              <div className={testStatus.report.ok ? 'gta-ok' : 'gta-error'}>
                <p style={{ margin: 0 }}>
                  {testStatus.report.ok ? t('settings.testOk') : t('settings.testFailed')} ·{' '}
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
              <p className="gta-error">
                {t('settings.testRequestFailed', { message: testStatus.message })}
              </p>
            )}
          </form>
        </div>
      </div>

      <div className="gta-panel" style={{ marginTop: 'var(--gta-s4)' }}>
        <div className="gta-panel-body">
          <h3 className="gta-card-title">{t('update.title')}</h3>
          <p className="gta-hint">{t('update.description')}</p>
          {updateStatus && (
            <div className="gta-update-row" data-testid="update-status">
              <div>
                <strong>{updateStatusLabel(updateStatus, t)}</strong>
                <p className="gta-hint" style={{ marginBottom: 0 }}>
                  {t('update.current', { version: updateStatus.currentVersion })}
                  {'version' in updateStatus && updateStatus.version
                    ? ` · ${t('update.latest', { version: updateStatus.version })}`
                    : ''}
                </p>
              </div>
              <div className="gta-actions">
                {(updateStatus.state === 'idle' ||
                  updateStatus.state === 'not-available' ||
                  updateStatus.state === 'error') && (
                  <button
                    type="button"
                    className="gta-btn gta-btn--ghost"
                    onClick={() => void runUpdateAction('check')}
                  >
                    {t('update.check')}
                  </button>
                )}
                {updateStatus.state === 'available' && (
                  <button
                    type="button"
                    className="gta-btn"
                    onClick={() => void runUpdateAction('download')}
                  >
                    {t('update.download')}
                  </button>
                )}
                {updateStatus.state === 'downloaded' && (
                  <button
                    type="button"
                    className="gta-btn"
                    onClick={() => void runUpdateAction('install')}
                  >
                    {t('update.install')}
                  </button>
                )}
              </div>
            </div>
          )}
          {updateStatus?.state === 'downloading' && (
            <progress
              className="gta-update-progress"
              max={100}
              value={updateStatus.percent}
              aria-label={t('update.progressLabel')}
            />
          )}
          {updateStatus?.state === 'error' && <p className="gta-error">{updateStatus.message}</p>}
          {updateActionError && <p className="gta-error">{updateActionError}</p>}
        </div>
      </div>
    </section>
  );
}

function parseCustomHeaders(value: string, invalidMessage: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    const name = separator >= 0 ? line.slice(0, separator).trim() : '';
    const headerValue = separator >= 0 ? line.slice(separator + 1).trim() : '';
    if (!name || !headerValue || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) {
      throw new Error(invalidMessage);
    }
    headers[name] = headerValue;
  }
  return headers;
}

function updateStatusLabel(status: UpdateStatus, t: ReturnType<typeof useI18n>['t']): string {
  switch (status.state) {
    case 'disabled':
      return t('update.disabled');
    case 'idle':
      return t('update.idle');
    case 'checking':
      return t('update.checking');
    case 'available':
      return t('update.available');
    case 'not-available':
      return t('update.notAvailable');
    case 'downloading':
      return t('update.downloading', { percent: status.percent.toFixed(0) });
    case 'downloaded':
      return t('update.downloaded');
    case 'error':
      return t('update.error');
  }
}
