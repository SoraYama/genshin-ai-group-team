import { useCallback, useEffect, useState } from 'react';
import { api } from '../../ipc';
import type {
  CharacterProfile,
  PersistedProfile,
  ProfileStateView,
  RefreshSummary
} from '../../../shared/domain';
import { ButtonGlyph, ElementIcon, PortraitFallback, StarIcon } from '../../design/Icons';
import { normalizeElement } from '../../design/tokens';

interface RosterPageProps {
  state: ProfileStateView;
  onStateChange: () => Promise<void>;
  onGotoOnboarding: () => void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading'; label?: string }
  | { kind: 'error'; message: string };

const SOURCE_LABEL: Record<PersistedProfile['source'], string> = {
  miyoushe: '米游社',
  'miyoushe+enka': '米游社 + Enka',
  enka: 'Enka',
  merged: '米游社 + Enka 融合',
  'miyoushe-stale': '米游社（已过期）'
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

export function RosterPage({ state, onStateChange, onGotoOnboarding }: RosterPageProps) {
  const [profile, setProfile] = useState<PersistedProfile | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [lastRefresh, setLastRefresh] = useState<RefreshSummary | null>(null);
  const [authHasCookie, setAuthHasCookie] = useState<boolean>(false);

  const activeUid = state.activeUid;

  const refreshAuthState = useCallback(async () => {
    try {
      const auth = await api.miyoushe.authState();
      setAuthHasCookie(auth.hasCookie);
    } catch {
      setAuthHasCookie(false);
    }
  }, []);

  useEffect(() => {
    void refreshAuthState();
  }, [refreshAuthState]);

  const loadProfile = useCallback(async (uid: string) => {
    setStatus({ kind: 'loading' });
    try {
      const next = await api.profile.get({ uid });
      setProfile(next);
      setStatus({ kind: 'idle' });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : '加载失败'
      });
    }
  }, []);

  useEffect(() => {
    if (!activeUid) {
      setProfile(null);
      return;
    }
    void loadProfile(activeUid);
  }, [activeUid, loadProfile]);

  async function handleSetActive(uid: string) {
    await api.profile.setActive({ uid });
    await onStateChange();
  }

  async function handleRefresh() {
    if (!activeUid) {
      return;
    }
    setStatus({ kind: 'loading', label: '正在刷新…' });
    try {
      const outcome = await api.profile.refresh({ uid: activeUid });
      setProfile(outcome.profile);
      setLastRefresh(outcome.summary);
      setStatus({ kind: 'idle' });
      await onStateChange();
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : '刷新失败'
      });
    }
  }

  async function handleReloginAndRefresh() {
    if (!activeUid) return;
    setStatus({ kind: 'loading', label: '等待米游社浏览器登录…' });
    try {
      const login = await api.miyoushe.loginViaBrowser();
      if (!login.ok) {
        setStatus({
          kind: 'error',
          message:
            login.reason === 'cancelled'
              ? '已取消登录'
              : login.message ?? `登录失败：${login.reason}`
        });
        return;
      }
      const match = login.bind.roles.find((r) => r.gameUid === activeUid);
      if (!match) {
        setStatus({
          kind: 'error',
          message: '登录的米游社账号不包含当前 UID，请改用相应账号登录或绑定新 UID'
        });
        return;
      }
      setStatus({ kind: 'loading', label: '正在拉取全角色…' });
      const refreshed = await api.profile.importFromSession({
        sessionId: login.sessionId,
        uid: activeUid
      });
      setProfile(refreshed);
      setLastRefresh({
        enka: refreshed.characters.some((c) => c.source !== 'miyoushe') ? 'ok' : 'failed',
        enkaCharacterCount: refreshed.characters.filter((c) => c.source !== 'miyoushe').length,
        miyoushe: 'ok',
        miyousheCharacterCount: refreshed.characters.filter(
          (c) => c.source === 'miyoushe' || c.source === 'merged'
        ).length,
        totalCharacterCount: refreshed.characters.length
      });
      setStatus({ kind: 'idle' });
      await onStateChange();
      await refreshAuthState();
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : '重新登录失败'
      });
    }
  }

  async function handleLogout() {
    setStatus({ kind: 'loading', label: '正在退出米游社登录…' });
    try {
      await api.miyoushe.logout();
      setLastRefresh(null);
      setStatus({ kind: 'idle' });
      await refreshAuthState();
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : '退出失败'
      });
    }
  }

  async function handlePing() {
    if (!activeUid) return;
    setStatus({ kind: 'loading', label: '正在测试米游社连接…' });
    try {
      const result = await api.miyoushe.ping({ uid: activeUid });
      if (result.ok) {
        setStatus({
          kind: 'error',
          message:
            `✓ 米游社连接 OK — 昵称 ${result.nickname ?? '?'}，` +
            `世界等级 ${result.worldLevel ?? '?'}，` +
            `账号共 ${result.totalCharacters ?? '?'} 角色`
        });
      } else {
        setStatus({
          kind: 'error',
          message: `✗ 米游社连接失败：${result.reason}${result.retcode !== undefined ? ` (retcode=${result.retcode})` : ''}`
        });
      }
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : '测试失败'
      });
    }
  }

  async function handleDelete(uid: string) {
    await api.profile.delete({ uid });
    await onStateChange();
  }

  if (state.profiles.length === 0) {
    return (
      <section>
        <h2 className="gta-section-title">
          角色面板
          <span className="gta-section-sub">ROSTER</span>
        </h2>
        <div className="gta-panel">
          <div className="gta-panel-body">
            <p className="gta-hint">还没有绑定任何账号。</p>
            <div className="gta-actions">
              <button type="button" className="gta-btn" onClick={onGotoOnboarding}>
                <span className="gta-btn-icon">
                  <ButtonGlyph name="plus" />
                </span>
                去绑定米游社账号
              </button>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="gta-section-title">
        角色面板
        <span className="gta-section-sub">ROSTER</span>
      </h2>

      <div className="gta-panel" style={{ marginBottom: 'var(--gta-s4)' }}>
        <div className="gta-panel-body">
          <div className="gta-uid-tabs">
            {state.profiles.map((item) => {
              const isActive = item.uid === activeUid;
              return (
                <button
                  key={item.uid}
                  type="button"
                  className={isActive ? 'gta-uid-tab is-active' : 'gta-uid-tab'}
                  onClick={() => void handleSetActive(item.uid)}
                >
                  <span className="uid">UID {item.uid}</span>
                  <span className="nickname">{item.nickname ?? '—'}</span>
                  <span className="count">{item.characterCount} 角色</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {status.kind === 'error' && <p className="gta-error">{status.message}</p>}
      {status.kind === 'loading' && status.label && (
        <p className="gta-hint">{status.label}</p>
      )}
      {lastRefresh && status.kind === 'idle' && (
        <RefreshBanner
          summary={lastRefresh}
          onRelogin={() => void handleReloginAndRefresh()}
        />
      )}

      {profile && (
        <>
          <div className="gta-panel" style={{ marginBottom: 'var(--gta-s4)' }}>
            <div className="gta-panel-body">
              <div className="gta-profile-row">
                <dl className="gta-meta-grid" style={{ margin: 0 }}>
                  <div className="gta-meta-cell">
                    <dt className="gta-meta-label">UID</dt>
                    <dd className="gta-meta-value is-mono" style={{ margin: 0 }}>
                      {profile.uid}
                    </dd>
                  </div>
                  <div className="gta-meta-cell">
                    <dt className="gta-meta-label">昵称</dt>
                    <dd className="gta-meta-value" style={{ margin: 0 }}>
                      {profile.nickname ?? '—'}
                    </dd>
                  </div>
                  <div className="gta-meta-cell">
                    <dt className="gta-meta-label">世界等级</dt>
                    <dd className="gta-meta-value is-mono" style={{ margin: 0 }}>
                      {profile.level ?? '—'}
                    </dd>
                  </div>
                  <div className="gta-meta-cell">
                    <dt className="gta-meta-label">数据来源</dt>
                    <dd className="gta-meta-value" style={{ margin: 0 }}>
                      {SOURCE_LABEL[profile.source]}
                    </dd>
                  </div>
                  <div className="gta-meta-cell">
                    <dt className="gta-meta-label">刷新时间</dt>
                    <dd className="gta-meta-value is-mono" style={{ margin: 0 }}>
                      {formatTime(profile.fetchedAt)}
                    </dd>
                  </div>
                </dl>
                <div className="gta-actions">
                  <button
                    type="button"
                    className="gta-btn"
                    onClick={() => void handleRefresh()}
                    disabled={!activeUid || status.kind === 'loading'}
                  >
                    <span className="gta-btn-icon">
                      <ButtonGlyph name="refresh" />
                    </span>
                    {status.kind === 'loading' ? '刷新中…' : '刷新数据'}
                  </button>
                  <button
                    type="button"
                    className="gta-btn gta-btn--ghost"
                    onClick={() => void handleReloginAndRefresh()}
                    disabled={!activeUid || status.kind === 'loading'}
                    title="弹出米游社登录窗口，重新拉取全部角色 + 武器 + 圣遗物"
                  >
                    <span className="gta-btn-icon">
                      <ButtonGlyph name="refresh" />
                    </span>
                    {authHasCookie ? '更换米游社账号' : '登录米游社'}
                  </button>
                  {authHasCookie && (
                    <>
                      <button
                        type="button"
                        className="gta-btn gta-btn--ghost"
                        onClick={() => void handlePing()}
                        disabled={status.kind === 'loading'}
                        title="只调用 /index 探针，验证 cookie + DS 签名是否能跑通"
                      >
                        测试米游社连接
                      </button>
                      <button
                        type="button"
                        className="gta-btn gta-btn--ghost"
                        onClick={() => void handleLogout()}
                        disabled={status.kind === 'loading'}
                        title="清除本地保存的米游社 cookie"
                      >
                        退出米游社登录
                      </button>
                    </>
                  )}
                  <button type="button" className="gta-btn gta-btn--ghost" onClick={onGotoOnboarding}>
                    绑定新账号
                  </button>
                  <button
                    type="button"
                    className="gta-btn gta-btn--danger"
                    onClick={() => void handleDelete(profile.uid)}
                  >
                    <span className="gta-btn-icon">
                      <ButtonGlyph name="trash" />
                    </span>
                    删除缓存
                  </button>
                </div>
              </div>
            </div>
          </div>

          {profile.characters.length === 0 ? (
            <div className="gta-panel">
              <div className="gta-panel-body">
                <p className="gta-hint">
                  当前没有角色面板数据。请在游戏内将想分析的角色放进角色展示柜，等约 5
                  分钟后回到这里点 &ldquo;刷新 Enka&rdquo;。
                </p>
              </div>
            </div>
          ) : (
            <div className="gta-grid">
              {profile.characters.map((character) => (
                <CharacterCard key={character.id} character={character} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

interface CharacterCardProps {
  character: CharacterProfile;
}

function CharacterCard({ character }: CharacterCardProps) {
  const element = normalizeElement(character.element);
  const stars = Math.max(1, Math.min(5, character.rarity));
  return (
    <article className={`gta-card r${stars}`}>
      <div className="gta-card-head">
        <div className="gta-portrait">
          <div className="gta-portrait-frame">
            {character.imageUrl ? (
              <img src={character.imageUrl} alt={character.name} loading="lazy" />
            ) : (
              <PortraitFallback />
            )}
          </div>
          <div className="gta-portrait-element">
            <ElementIcon element={element} size={18} />
          </div>
        </div>
        <div className="gta-identity">
          <h3 className="gta-name">{character.name}</h3>
          <div className="gta-rank-row">
            <span className={stars === 5 ? 'gta-rank-stars r5' : 'gta-rank-stars'}>
              {Array.from({ length: stars }).map((_, i) => (
                <StarIcon key={i} />
              ))}
            </span>
            <span className="gta-level">
              Lv <span className="num">{character.stats.level}</span>
            </span>
          </div>
        </div>
      </div>
      <div className="gta-card-divider" />
      <dl className="gta-stats">
        <Stat label="攻击" value={character.stats.atk} />
        <Stat label="生命" value={character.stats.hp} />
        <Stat label="防御" value={character.stats.def} />
        <Stat label="暴击率" value={character.stats.critRate} suffix="%" />
        <Stat label="暴伤" value={character.stats.critDmg} suffix="%" />
        <Stat label="充能" value={character.stats.energyRecharge} suffix="%" />
        <Stat label="精通" value={character.stats.elementalMastery} />
      </dl>
    </article>
  );
}

function Stat({ label, value, suffix }: { label: string; value: number; suffix?: string }) {
  return (
    <div className="gta-stat">
      <dt className="gta-stat-label">{label}</dt>
      <dd className="gta-stat-value" style={{ margin: 0 }}>
        {value}
        {suffix && <span className="pct">{suffix}</span>}
      </dd>
    </div>
  );
}

interface RefreshBannerProps {
  summary: RefreshSummary;
  onRelogin: () => void;
}

const MIYOUSHE_STATUS_LABEL: Record<RefreshSummary['miyoushe'], string> = {
  ok: '✓ 拉取成功',
  failed: '⚠ 拉取失败',
  skipped: '— 跳过',
  'no-cookie': '— 未登录米游社',
  'auth-expired': '⚠ 登录已过期',
  'captcha-required': '⚠ 需要在米游社完成验证',
  'rate-limited': '⚠ 触发限频，请稍后再试'
};

const ENKA_STATUS_LABEL: Record<RefreshSummary['enka'], string> = {
  ok: '✓ 拉取成功',
  failed: '⚠ 拉取失败',
  skipped: '— 跳过',
  'no-cookie': '—',
  'auth-expired': '—',
  'captcha-required': '—',
  'rate-limited': '—'
};

function RefreshBanner({ summary, onRelogin }: RefreshBannerProps) {
  const needsRelogin =
    summary.miyoushe === 'no-cookie' || summary.miyoushe === 'auth-expired';
  return (
    <div
      className="gta-panel"
      style={{ marginBottom: 'var(--gta-s4)', borderColor: 'var(--gta-accent-soft)' }}
    >
      <div className="gta-panel-body" style={{ paddingTop: 'var(--gta-s3)', paddingBottom: 'var(--gta-s3)' }}>
        <div className="gta-meta-grid" style={{ margin: 0 }}>
          <div className="gta-meta-cell">
            <dt className="gta-meta-label">米游社全角色</dt>
            <dd className="gta-meta-value" style={{ margin: 0 }}>
              {MIYOUSHE_STATUS_LABEL[summary.miyoushe]}
              {summary.miyoushe === 'ok' && (
                <span className="gta-mono">（{summary.miyousheCharacterCount} 角色）</span>
              )}
            </dd>
            {summary.miyousheError && summary.miyoushe !== 'ok' && (
              <p className="gta-hint" style={{ marginTop: 4 }}>
                {summary.miyousheError}
              </p>
            )}
          </div>
          <div className="gta-meta-cell">
            <dt className="gta-meta-label">Enka 展示柜</dt>
            <dd className="gta-meta-value" style={{ margin: 0 }}>
              {ENKA_STATUS_LABEL[summary.enka]}
              {summary.enka === 'ok' && (
                <span className="gta-mono">（{summary.enkaCharacterCount} 角色）</span>
              )}
            </dd>
            {summary.enkaError && summary.enka !== 'ok' && (
              <p className="gta-hint" style={{ marginTop: 4 }}>
                {summary.enkaError}
              </p>
            )}
          </div>
          <div className="gta-meta-cell">
            <dt className="gta-meta-label">合并后总角色</dt>
            <dd className="gta-meta-value is-mono" style={{ margin: 0 }}>
              {summary.totalCharacterCount}
            </dd>
          </div>
        </div>
        {needsRelogin && (
          <div className="gta-actions" style={{ marginTop: 'var(--gta-s3)' }}>
            <p className="gta-hint" style={{ margin: 0, flex: 1 }}>
              {summary.miyoushe === 'no-cookie'
                ? '当前 UID 还没有登录态，米游社全角色无法拉取。'
                : '米游社登录态已过期，建议重新登录。'}
            </p>
            <button
              type="button"
              className="gta-btn"
              onClick={onRelogin}
            >
              <span className="gta-btn-icon">
                <ButtonGlyph name="refresh" />
              </span>
              重新登录米游社
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
