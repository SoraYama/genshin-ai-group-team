import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DataManagementScope,
  DataManagementSummary,
  LlmHealthReport,
  PublicConfig,
  UpdateStatus
} from '../../../shared/domain';
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../../../shared/domain';
import { EmptyState } from '../../components/ui/EmptyState';
import { GtaDialog } from '../../components/ui/GtaDialog';
import { destructiveErrorRecovery, getErrorCode, localizeError, useI18n } from '../../i18n';
import { api } from '../../ipc';
import { dataClearCopy, formatStorageSize } from './settings-presentation';
import { SettingsLoadState } from './SettingsLoadState';

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

interface PendingClear {
  scope: DataManagementScope;
  count: number;
  confirmationToken: string;
}

export function SettingsPage({
  onProfileDataChange
}: {
  onProfileDataChange?: () => Promise<void>;
}) {
  const { locale, t } = useI18n();
  const language = locale === 'en-US' ? 'en' : 'zh';
  const isEnglish = language === 'en';
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [dataSummary, setDataSummary] = useState<DataManagementSummary | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [customHeadersText, setCustomHeadersText] = useState('');
  const [replaceCustomHeaders, setReplaceCustomHeaders] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: 'idle' });
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateActionError, setUpdateActionError] = useState('');
  const [pendingClear, setPendingClear] = useState<PendingClear | null>(null);
  const [dataError, setDataError] = useState('');
  const [dataErrorCode, setDataErrorCode] = useState('');
  const [dataRetryScope, setDataRetryScope] = useState<DataManagementScope | null>(null);
  const [loadFailure, setLoadFailure] = useState('');
  const cancelClearRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    const [nextConfig, nextData] = await Promise.all([
      api.config.getPublic(),
      api.dataManagement.summary()
    ]);
    setConfig(nextConfig);
    setDataSummary(nextData);
    setBaseUrl(nextConfig.llm.baseUrl);
    setModel(nextConfig.llm.model);
  }, []);

  const loadSettings = useCallback(async () => {
    setLoadFailure('');
    try {
      await refresh();
    } catch (error) {
      setLoadFailure(localizeError(error, locale, t, 'common.error.unknown'));
    }
  }, [locale, refresh, t]);

  useEffect(() => {
    void loadSettings();
    const unsubscribe = api.update.onEvent(setUpdateStatus);
    void api.update.getState().then(setUpdateStatus);
    return unsubscribe;
  }, [loadSettings]);

  async function handleSave() {
    setSaveStatus({ kind: 'saving' });
    try {
      const trimmedKey = apiKey.trim();
      await api.config.setLlm({
        apiKey: trimmedKey || undefined,
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim() || undefined,
        customHeaders: replaceCustomHeaders
          ? parseCustomHeaders(
              customHeadersText,
              isEnglish
                ? 'Use Name: value for each additional request value.'
                : '附加请求信息格式不正确，请使用“名称: 内容”。'
            )
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
      setTestStatus({ kind: 'done', report: await api.config.testLlm() });
    } catch (error) {
      setTestStatus({
        kind: 'error',
        message: localizeError(error, locale, t, 'common.error.unknown')
      });
    }
  }

  async function prepareClear(scope: DataManagementScope) {
    setDataError('');
    setDataErrorCode('');
    setDataRetryScope(null);
    try {
      const confirmation = await api.dataManagement.prepareClear({ scope });
      setPendingClear({ scope, ...confirmation });
    } catch (error) {
      setDataError(localizeError(error, locale, t, 'common.error.validation'));
      setDataErrorCode(getErrorCode(error));
      setDataRetryScope(scope);
    }
  }

  async function confirmClear() {
    if (!pendingClear) return;
    const request = pendingClear;
    setPendingClear(null);
    setDataError('');
    setDataErrorCode('');
    setDataRetryScope(null);
    try {
      const result = await api.dataManagement.clear({
        scope: request.scope,
        expectedCount: request.count,
        confirmationToken: request.confirmationToken
      });
      setDataSummary(result.summary);
      if (request.scope === 'service-key') {
        setTestStatus({ kind: 'idle' });
        setSaveStatus({ kind: 'idle' });
        await refresh();
      }
      if (request.scope === 'profiles') await onProfileDataChange?.();
    } catch (error) {
      setDataError(localizeError(error, locale, t, 'common.error.validation'));
      setDataErrorCode(getErrorCode(error));
      setDataRetryScope(request.scope);
      await refresh();
    }
  }

  async function runUpdateAction(action: 'check' | 'download' | 'install') {
    setUpdateActionError('');
    try {
      await api.update[action]();
    } catch (error) {
      setUpdateActionError(localizeError(error, locale, t, 'common.error.unknown'));
    }
  }

  if (!config || !dataSummary) {
    return (
      <SettingsLoadState
        failure={loadFailure}
        isEnglish={isEnglish}
        onRetry={() => void loadSettings()}
      />
    );
  }

  const serviceState =
    testStatus.kind === 'done'
      ? testStatus.report.ok
        ? isEnglish
          ? 'Connection works'
          : '连接正常'
        : isEnglish
          ? 'Connection needs attention'
          : '连接需要处理'
      : config.llm.hasApiKey
        ? isEnglish
          ? 'Key saved · connection not tested'
          : '密钥已保存 · 尚未检测连接'
        : isEnglish
          ? 'Not configured'
          : '未配置';
  const dataErrorRecovery = destructiveErrorRecovery(dataErrorCode, locale);

  return (
    <section className="gta-settings-page">
      <header className="gta-page-head">
        <div>
          <span className="gta-page-kicker">
            {isEnglish ? 'Local preferences and storage' : '本机偏好与数据'}
          </span>
          <h2 className="gta-section-title">{isEnglish ? 'Settings' : '设置'}</h2>
          <p className="gta-page-lead">
            {isEnglish
              ? 'Manage the smart service and local data without exposing saved secrets.'
              : '管理智能服务与本机资料；已保存的密钥和附加请求内容不会回显。'}
          </p>
        </div>
      </header>

      <section
        className="gta-settings-section gta-settings-service"
        aria-labelledby="service-title"
      >
        <div className="gta-settings-section-head">
          <div>
            <span className="gta-page-kicker">
              {isEnglish ? 'Recommendation service' : '推荐服务'}
            </span>
            <h3 id="service-title">{isEnglish ? 'Smart service' : '智能服务'}</h3>
          </div>
          <span className={config.llm.hasApiKey ? 'is-ready' : 'is-missing'}>{serviceState}</span>
        </div>

        <dl className="gta-settings-status">
          <div>
            <dt>{isEnglish ? 'Connection' : '连接状态'}</dt>
            <dd>{serviceState}</dd>
          </div>
          <div>
            <dt>{isEnglish ? 'Current model' : '当前模型'}</dt>
            <dd>{config.llm.model}</dd>
          </div>
          <div>
            <dt>{isEnglish ? 'Service key' : '服务密钥'}</dt>
            <dd>
              {config.llm.hasApiKey
                ? isEnglish
                  ? 'Saved securely'
                  : '已安全保存'
                : isEnglish
                  ? 'Not configured'
                  : '未配置'}
            </dd>
          </div>
        </dl>

        {!config.llm.hasApiKey && <EmptyState kind="service" locale={language} />}

        <div className="gta-settings-key-row">
          <label>
            <span>{isEnglish ? 'New service key' : '新的服务密钥'}</span>
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                config.llm.hasApiKey
                  ? isEnglish
                    ? 'Leave blank to keep the saved key'
                    : '留空则保留已保存密钥'
                  : isEnglish
                    ? 'Enter your service key'
                    : '输入你的服务密钥'
              }
              autoComplete="new-password"
            />
          </label>
          <button
            type="button"
            className="gta-btn"
            disabled={
              saveStatus.kind === 'saving' || (!config.llm.hasApiKey && apiKey.trim().length === 0)
            }
            onClick={() => void handleSave()}
          >
            {saveStatus.kind === 'saving'
              ? isEnglish
                ? 'Saving…'
                : '正在保存…'
              : isEnglish
                ? 'Save service settings'
                : '保存服务设置'}
          </button>
        </div>
        <p className="gta-settings-privacy">
          {isEnglish
            ? 'The key is protected by the operating system and stays on this device. It is sent only to the service address you configure when testing or generating a plan.'
            : '服务密钥由操作系统加密保护，只保存在这台设备上；仅在检测连接或生成方案时发往你配置的服务地址。'}
        </p>
        {saveStatus.kind === 'saved' && (
          <p className="gta-ok">{isEnglish ? 'Service settings saved.' : '服务设置已保存。'}</p>
        )}
        {saveStatus.kind === 'error' && <p className="gta-error">{saveStatus.message}</p>}
      </section>

      <section className="gta-settings-section" aria-labelledby="freshness-title">
        <div className="gta-settings-section-head">
          <div>
            <span className="gta-page-kicker">{isEnglish ? 'Freshness' : '更新时间'}</span>
            <h3 id="freshness-title">{isEnglish ? 'Local data status' : '本机资料状态'}</h3>
          </div>
        </div>
        <dl className="gta-settings-status is-data">
          <DataFreshness
            label={isEnglish ? 'Character data' : '角色资料'}
            count={dataSummary.profiles.count}
            updatedAt={dataSummary.profiles.updatedAt}
            isEnglish={isEnglish}
          />
          <DataFreshness
            label={isEnglish ? 'Challenge data' : '挑战资料'}
            count={dataSummary.scenarios.count}
            updatedAt={dataSummary.scenarios.updatedAt}
            isEnglish={isEnglish}
          />
          <DataFreshness
            label={isEnglish ? 'Recommendation history' : '推荐记录'}
            count={dataSummary.history.count}
            updatedAt={dataSummary.history.updatedAt}
            isEnglish={isEnglish}
          />
        </dl>
      </section>

      <section className="gta-settings-section" aria-labelledby="data-management-title">
        <div className="gta-settings-section-head">
          <div>
            <span className="gta-page-kicker">{isEnglish ? 'On this device' : '仅限本机'}</span>
            <h3 id="data-management-title">{isEnglish ? 'Data management' : '数据管理'}</h3>
          </div>
          <p>
            {isEnglish
              ? 'Each category is cleared independently.'
              : '每类资料单独清理，不提供含糊的“一键重置”。'}
          </p>
        </div>
        <div className="gta-data-management-list">
          <DataManagementRow
            title={isEnglish ? 'Character data' : '角色资料'}
            meta={
              isEnglish
                ? `${dataSummary.profiles.count} profiles · ${formatStorageSize(dataSummary.profiles.sizeBytes, language)}`
                : `${dataSummary.profiles.count} 份资料 · ${formatStorageSize(dataSummary.profiles.sizeBytes, language)}`
            }
            impact={
              isEnglish
                ? 'Removes saved characters and build panels; sign-in state remains.'
                : '删除已保存角色与装备面板；不会退出登录。'
            }
            action={isEnglish ? 'Clear character data' : '清除角色资料'}
            disabled={dataSummary.profiles.count === 0}
            onClear={() => void prepareClear('profiles')}
          />
          <DataManagementRow
            title={isEnglish ? 'Challenge cache' : '挑战资料缓存'}
            meta={
              isEnglish
                ? `${dataSummary.scenarios.clearableCount} downloaded + ${dataSummary.guideResearch.count} temporary guides · ${formatStorageSize((dataSummary.scenarios.sizeBytes ?? 0) + (dataSummary.guideResearch.sizeBytes ?? 0), language)}`
                : `${dataSummary.scenarios.clearableCount} 份已下载 + ${dataSummary.guideResearch.count} 条临时攻略 · ${formatStorageSize((dataSummary.scenarios.sizeBytes ?? 0) + (dataSummary.guideResearch.sizeBytes ?? 0), language)}`
            }
            impact={
              isEnglish
                ? 'Removes downloaded updates and temporary web-guide summaries; bundled trusted knowledge remains.'
                : '移除下载更新与临时网页攻略摘要；应用随附的可信知识库保留。'
            }
            action={isEnglish ? 'Clear challenge cache' : '清除挑战资料缓存'}
            disabled={dataSummary.scenarios.clearableCount + dataSummary.guideResearch.count === 0}
            onClear={() => void prepareClear('scenarios')}
          />
          <DataManagementRow
            title={isEnglish ? 'Recommendation history' : '推荐记录'}
            meta={
              isEnglish
                ? `${dataSummary.history.count} records · ${formatStorageSize(dataSummary.history.sizeBytes, language)}`
                : `${dataSummary.history.count} 条记录 · ${formatStorageSize(dataSummary.history.sizeBytes, language)}`
            }
            impact={
              isEnglish
                ? 'Permanently removes old plans; character data remains.'
                : '永久删除旧方案；角色资料不会受影响。'
            }
            action={isEnglish ? 'Clear recommendation history' : '清除推荐记录'}
            disabled={dataSummary.history.count === 0}
            onClear={() => void prepareClear('history')}
          />
          <DataManagementRow
            title={isEnglish ? 'Smart-service key' : '智能服务密钥'}
            meta={
              dataSummary.serviceKey.count
                ? isEnglish
                  ? 'Saved securely'
                  : '已安全保存'
                : isEnglish
                  ? 'Not configured'
                  : '未配置'
            }
            impact={
              isEnglish
                ? 'Removes only the saved key; model and local data remain.'
                : '只删除服务密钥；模型名称与本机资料保留。'
            }
            action={isEnglish ? 'Clear service key' : '清除服务密钥'}
            disabled={dataSummary.serviceKey.count === 0}
            onClear={() => void prepareClear('service-key')}
          />
        </div>
        {dataError && (
          <div className="gta-error gta-data-management-error" role="alert">
            <span>{dataError}</span>
            {dataRetryScope && dataErrorRecovery.kind !== 'none' && (
              <button
                type="button"
                className="gta-text-action"
                onClick={() => void prepareClear(dataRetryScope)}
              >
                {dataErrorRecovery.label}
              </button>
            )}
          </div>
        )}
      </section>

      <section className="gta-settings-advanced">
        <button
          type="button"
          className="gta-settings-advanced-trigger"
          aria-expanded={advancedOpen}
          aria-controls="advanced-settings-content"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          <span>
            <strong>{isEnglish ? 'Advanced settings' : '高级设置'}</strong>
            <small>
              {isEnglish
                ? 'Service address, model editing, diagnostics, usage, and app updates'
                : '服务地址、模型编辑、连接诊断、用量与应用更新'}
            </small>
          </span>
          <span aria-hidden="true">{advancedOpen ? '−' : '+'}</span>
        </button>
        <div id="advanced-settings-content" hidden={!advancedOpen}>
          <div className="gta-settings-advanced-grid">
            <label>
              <span>{isEnglish ? 'Service address' : '服务地址'}</span>
              <input
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={DEFAULT_BASE_URL}
              />
            </label>
            <label>
              <span>{isEnglish ? 'Model name' : '模型名称'}</span>
              <input
                type="text"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder={DEFAULT_MODEL}
              />
            </label>
          </div>
          <label className="gta-settings-header-input">
            <span>{isEnglish ? 'Additional request information' : '附加请求信息'}</span>
            <textarea
              value={customHeadersText}
              onChange={(event) => setCustomHeadersText(event.target.value)}
              rows={3}
              disabled={!replaceCustomHeaders}
              spellCheck={false}
              autoComplete="off"
              placeholder={isEnglish ? 'Name: private value' : '名称: 私密内容'}
            />
            <small>
              {isEnglish
                ? 'One Name: value pair per line. Values are encrypted and never shown again.'
                : '每行一项“名称: 内容”；内容加密保存，之后不会回显。'}
            </small>
          </label>
          <label className="gta-checkbox-row">
            <input
              type="checkbox"
              checked={replaceCustomHeaders}
              onChange={(event) => setReplaceCustomHeaders(event.target.checked)}
            />
            <span>
              {isEnglish
                ? 'Replace additional request information when saving'
                : '本次保存时替换附加请求信息'}
            </span>
          </label>
          <div className="gta-actions">
            <button type="button" className="gta-btn" onClick={() => void handleSave()}>
              {isEnglish ? 'Save advanced settings' : '保存高级设置'}
            </button>
            <button
              type="button"
              className="gta-btn gta-btn--ghost"
              disabled={!config.llm.hasApiKey || testStatus.kind === 'running'}
              onClick={() => void handleTest()}
            >
              {testStatus.kind === 'running'
                ? isEnglish
                  ? 'Testing…'
                  : '正在检测…'
                : isEnglish
                  ? 'Test connection'
                  : '检测连接'}
            </button>
          </div>
          {testStatus.kind === 'done' && (
            <div className={testStatus.report.ok ? 'gta-ok' : 'gta-error'}>
              <strong>
                {testStatus.report.ok
                  ? isEnglish
                    ? 'Connection works'
                    : '连接正常'
                  : isEnglish
                    ? 'Connection failed'
                    : '连接失败'}
              </strong>
              <span>
                {isEnglish ? 'Response time' : '响应时间'}：{testStatus.report.latencyMs} ms
              </span>
              {testStatus.report.message && <p>{testStatus.report.message}</p>}
            </div>
          )}
          {testStatus.kind === 'error' && <p className="gta-error">{testStatus.message}</p>}
          <dl className="gta-settings-diagnostics">
            <div>
              <dt>{isEnglish ? 'Usage this month' : '本月使用量'}</dt>
              <dd>
                {config.monthlyUsage.inputTokens.toLocaleString()} /{' '}
                {config.monthlyUsage.outputTokens.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt>{isEnglish ? 'Estimated service cost' : '预估服务费用'}</dt>
              <dd>${config.monthlyUsage.estimatedCostUsd.toFixed(4)}</dd>
            </div>
            <div>
              <dt>{isEnglish ? 'App version' : '应用版本'}</dt>
              <dd>{config.appVersion}</dd>
            </div>
          </dl>
          <UpdateControls status={updateStatus} isEnglish={isEnglish} onAction={runUpdateAction} />
          {updateActionError && <p className="gta-error">{updateActionError}</p>}
        </div>
      </section>

      <GtaDialog
        open={pendingClear !== null}
        title={
          pendingClear ? dataClearCopy(pendingClear.scope, pendingClear.count, language).title : ''
        }
        closeLabel={isEnglish ? 'Close confirmation' : '关闭确认框'}
        initialFocusRef={cancelClearRef}
        onClose={() => setPendingClear(null)}
      >
        {pendingClear && (
          <div className="gta-destructive-confirmation">
            <p>{dataClearCopy(pendingClear.scope, pendingClear.count, language).effect}</p>
            <p>{dataClearCopy(pendingClear.scope, pendingClear.count, language).preserves}</p>
            <p>{isEnglish ? 'This cannot be undone.' : '此操作无法撤销。'}</p>
            <div className="gta-actions">
              <button
                type="button"
                className="gta-btn gta-btn--danger"
                onClick={() => void confirmClear()}
              >
                {dataClearCopy(pendingClear.scope, pendingClear.count, language).action}
              </button>
              <button
                ref={cancelClearRef}
                type="button"
                className="gta-btn gta-btn--ghost"
                onClick={() => setPendingClear(null)}
              >
                {isEnglish ? 'Keep and go back' : '保留并返回'}
              </button>
            </div>
          </div>
        )}
      </GtaDialog>
    </section>
  );
}

function DataFreshness({
  count,
  isEnglish,
  label,
  updatedAt
}: {
  count: number;
  isEnglish: boolean;
  label: string;
  updatedAt?: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <strong>{count}</strong>
        <span>
          {updatedAt
            ? `${isEnglish ? 'Updated' : '更新于'} ${formatDate(updatedAt)}`
            : isEnglish
              ? 'No update time recorded'
              : '暂无更新时间'}
        </span>
      </dd>
    </div>
  );
}

function DataManagementRow({
  action,
  disabled,
  impact,
  meta,
  onClear,
  title
}: {
  action: string;
  disabled: boolean;
  impact: string;
  meta: string;
  onClear: () => void;
  title: string;
}) {
  return (
    <article>
      <div>
        <h4>{title}</h4>
        <strong>{meta}</strong>
        <p>{impact}</p>
      </div>
      <button
        type="button"
        className="gta-text-action is-danger"
        disabled={disabled}
        onClick={onClear}
      >
        {action}
      </button>
    </article>
  );
}

function UpdateControls({
  isEnglish,
  onAction,
  status
}: {
  isEnglish: boolean;
  onAction: (action: 'check' | 'download' | 'install') => Promise<void>;
  status: UpdateStatus | null;
}) {
  if (!status) return null;
  return (
    <section className="gta-settings-update">
      <h4>{isEnglish ? 'Application updates' : '应用更新'}</h4>
      <p>
        {updateStatusLabel(status, isEnglish)} ·{' '}
        {isEnglish ? `Current ${status.currentVersion}` : `当前版本 ${status.currentVersion}`}
      </p>
      <div className="gta-actions">
        {(status.state === 'idle' ||
          status.state === 'not-available' ||
          status.state === 'error') && (
          <button
            type="button"
            className="gta-btn gta-btn--ghost"
            onClick={() => void onAction('check')}
          >
            {isEnglish ? 'Check for updates' : '检查更新'}
          </button>
        )}
        {status.state === 'available' && (
          <button type="button" className="gta-btn" onClick={() => void onAction('download')}>
            {isEnglish ? 'Download update' : '下载更新'}
          </button>
        )}
        {status.state === 'downloaded' && (
          <button type="button" className="gta-btn" onClick={() => void onAction('install')}>
            {isEnglish ? 'Restart and install' : '重启并安装'}
          </button>
        )}
      </div>
      {status.state === 'downloading' && (
        <progress
          max={100}
          value={status.percent}
          aria-label={isEnglish ? 'Download progress' : '下载进度'}
        />
      )}
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

function updateStatusLabel(status: UpdateStatus, isEnglish: boolean): string {
  switch (status.state) {
    case 'disabled':
      return isEnglish ? 'Updates are unavailable in this build' : '此版本不提供自动更新';
    case 'idle':
      return isEnglish ? 'Not checked yet' : '尚未检查';
    case 'checking':
      return isEnglish ? 'Checking…' : '正在检查…';
    case 'available':
      return isEnglish ? 'A new version is available' : '发现新版本';
    case 'not-available':
      return isEnglish ? 'Up to date' : '已是最新版本';
    case 'downloading':
      return isEnglish
        ? `Downloading ${status.percent.toFixed(0)}%`
        : `正在下载 ${status.percent.toFixed(0)}%`;
    case 'downloaded':
      return isEnglish ? 'Ready to install' : '可以安装';
    case 'error':
      return isEnglish ? 'Update check failed' : '更新检查失败';
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
