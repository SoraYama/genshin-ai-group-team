import { useState } from 'react';
import { api } from '../../ipc';
import type { MiyousheRole } from '../../../shared/domain';

interface OnboardingPageProps {
  onBound: (uid: string) => void;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'logging-in' }
  | { kind: 'validating' }
  | { kind: 'roles'; roles: MiyousheRole[]; sessionId?: string }
  | { kind: 'importing' }
  | { kind: 'error'; message: string };

export function OnboardingPage({ onBound }: OnboardingPageProps) {
  const [cookie, setCookie] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [selectedUid, setSelectedUid] = useState<string | undefined>(undefined);

  async function handleBrowserLogin() {
    setPhase({ kind: 'logging-in' });
    setSelectedUid(undefined);
    try {
      const result = await api.miyoushe.loginViaBrowser();
      if (!result.ok) {
        if (result.reason === 'cancelled') {
          setPhase({ kind: 'idle' });
          return;
        }
        setPhase({
          kind: 'error',
          message: result.message ?? `登录失败 (${result.reason})`
        });
        return;
      }
      setSelectedUid(result.bind.roles[0]?.gameUid);
      setPhase({ kind: 'roles', roles: result.bind.roles, sessionId: result.sessionId });
    } catch (error) {
      setPhase({
        kind: 'error',
        message: error instanceof Error ? error.message : '登录请求失败'
      });
    }
  }

  async function handleValidateManual() {
    const trimmed = cookie.trim();
    if (trimmed.length < 10) {
      setPhase({ kind: 'error', message: 'Cookie 看起来不完整' });
      return;
    }
    setPhase({ kind: 'validating' });
    setSelectedUid(undefined);
    try {
      const result = await api.miyoushe.bind({ cookie: trimmed });
      if (!result.ok || result.roles.length === 0) {
        setPhase({
          kind: 'error',
          message: result.message ?? 'Cookie 无效或绑定的游戏角色为空'
        });
        return;
      }
      setSelectedUid(result.roles[0]?.gameUid);
      setPhase({ kind: 'roles', roles: result.roles });
    } catch (error) {
      setPhase({
        kind: 'error',
        message: error instanceof Error ? error.message : '校验失败'
      });
    }
  }

  async function handleImport() {
    if (phase.kind !== 'roles') {
      return;
    }
    const sessionId = phase.sessionId;
    const trimmedCookie = cookie.trim();
    setPhase({ kind: 'importing' });
    try {
      const profile = sessionId
        ? await api.profile.importFromSession({ sessionId, uid: selectedUid })
        : await api.profile.importFromCookie({ cookie: trimmedCookie, uid: selectedUid });
      onBound(profile.uid);
    } catch (error) {
      setPhase({
        kind: 'error',
        message: error instanceof Error ? error.message : '导入失败'
      });
    }
  }

  const isWorking =
    phase.kind === 'logging-in' || phase.kind === 'validating' || phase.kind === 'importing';

  return (
    <section className="onboarding-page">
      <h2>绑定米游社账号</h2>
      <p className="hint">
        推荐用内置浏览器扫码登录。Cookie 只在主进程内存中短暂存在，
        登录完成后从专用浏览器会话提取，绑定结束即从内存丢弃，**永不写入磁盘**。
      </p>

      <div className="primary-action">
        <button
          type="button"
          onClick={() => void handleBrowserLogin()}
          disabled={isWorking}
        >
          {phase.kind === 'logging-in' ? '等待登录完成…' : '用内置浏览器登录米游社'}
        </button>
        <p className="hint small">
          会弹出独立窗口加载 <code>miyoushe.com</code>，请用手机扫码或账号密码完成登录。检测到登录凭据后窗口会自动关闭。
        </p>
      </div>

      <details className="advanced-option">
        <summary>高级：手动粘贴 Cookie（不推荐）</summary>
        <ol>
          <li>用浏览器登录 <code>https://www.miyoushe.com/ys/</code></li>
          <li>F12 → Application → Cookies → 选中 <code>miyoushe.com</code></li>
          <li>复制 <code>ltoken_v2</code>、<code>ltuid_v2</code>、<code>ltmid_v2</code> 三对 key=value，用 <code>;</code> 串起来</li>
        </ol>
        <label className="cookie-field">
          Cookie
          <textarea
            value={cookie}
            onChange={(event) => setCookie(event.target.value)}
            placeholder="ltoken_v2=...; ltuid_v2=...; ltmid_v2=..."
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="button-row">
          <button
            type="button"
            onClick={() => void handleValidateManual()}
            disabled={isWorking || cookie.trim().length < 10}
          >
            {phase.kind === 'validating' ? '校验中…' : '校验 Cookie'}
          </button>
        </div>
      </details>

      {phase.kind === 'error' && <p className="error">{phase.message}</p>}

      {phase.kind === 'roles' && (
        <div className="role-picker">
          <p className="hint">检测到 {phase.roles.length} 个游戏角色，请选择要绑定的：</p>
          <ul>
            {phase.roles.map((role) => (
              <li key={role.gameUid}>
                <label>
                  <input
                    type="radio"
                    name="role-uid"
                    value={role.gameUid}
                    checked={selectedUid === role.gameUid}
                    onChange={() => setSelectedUid(role.gameUid)}
                  />
                  <span>
                    UID {role.gameUid}
                    {role.nickname && ` · ${role.nickname}`}
                    {role.level !== undefined && ` · Lv.${role.level}`}
                    {role.regionName && ` · ${role.regionName}`}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="button-row">
            <button type="button" onClick={() => void handleImport()} disabled={!selectedUid}>
              导入选定 UID
            </button>
          </div>
          {phase.sessionId && (
            <p className="hint small">登录凭据将在 5 分钟内有效；超时需要重新登录。</p>
          )}
        </div>
      )}

      {phase.kind === 'importing' && <p>正在拉取角色面板…</p>}
    </section>
  );
}
