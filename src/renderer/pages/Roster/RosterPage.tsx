import { useCallback, useEffect, useState } from 'react';
import { api } from '../../ipc';
import type { PersistedProfile, ProfileStateView } from '../../../shared/domain';

interface RosterPageProps {
  state: ProfileStateView;
  onStateChange: () => Promise<void>;
  onGotoOnboarding: () => void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string };

export function RosterPage({ state, onStateChange, onGotoOnboarding }: RosterPageProps) {
  const [profile, setProfile] = useState<PersistedProfile | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const activeUid = state.activeUid;

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
    setStatus({ kind: 'loading' });
    try {
      const refreshed = await api.profile.refresh({ uid: activeUid });
      setProfile(refreshed);
      setStatus({ kind: 'idle' });
      await onStateChange();
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Enka 刷新失败'
      });
    }
  }

  async function handleDelete(uid: string) {
    await api.profile.delete({ uid });
    await onStateChange();
  }

  if (state.profiles.length === 0) {
    return (
      <section className="roster-page">
        <p className="hint">还没有绑定任何账号。</p>
        <button type="button" onClick={onGotoOnboarding}>
          去绑定米游社账号
        </button>
      </section>
    );
  }

  return (
    <section className="roster-page">
      <header className="roster-header">
        <div>
          <h2>角色面板</h2>
          <p className="hint">数据本地缓存。Enka 仅返回角色展示柜内的角色（最多 8 个）。</p>
        </div>
        <div className="button-row">
          <button type="button" onClick={() => void handleRefresh()} disabled={!activeUid || status.kind === 'loading'}>
            {status.kind === 'loading' ? '刷新中…' : '刷新 Enka 数据'}
          </button>
          <button type="button" onClick={onGotoOnboarding}>
            绑定新账号
          </button>
        </div>
      </header>

      <div className="profile-tabs">
        {state.profiles.map((item) => {
          const isActive = item.uid === activeUid;
          return (
            <button
              key={item.uid}
              type="button"
              className={isActive ? 'tab tab-active' : 'tab'}
              onClick={() => void handleSetActive(item.uid)}
            >
              <span>UID {item.uid}</span>
              {item.nickname && <span className="muted">{item.nickname}</span>}
              <span className="muted">{item.characterCount} 角色</span>
            </button>
          );
        })}
      </div>

      {status.kind === 'error' && <p className="error">{status.message}</p>}

      {profile && (
        <>
          <dl className="profile-meta">
            <div>
              <dt>UID</dt>
              <dd>{profile.uid}</dd>
            </div>
            <div>
              <dt>昵称</dt>
              <dd>{profile.nickname ?? '—'}</dd>
            </div>
            <div>
              <dt>世界等级</dt>
              <dd>{profile.level ?? '—'}</dd>
            </div>
            <div>
              <dt>数据来源</dt>
              <dd>{profile.source}</dd>
            </div>
            <div>
              <dt>刷新时间</dt>
              <dd>{new Date(profile.fetchedAt).toLocaleString()}</dd>
            </div>
          </dl>

          {profile.characters.length === 0 ? (
            <p className="hint">
              当前没有角色面板数据。请在游戏内将想分析的角色放进角色展示柜，等约 5 分钟后回到这里点 &ldquo;刷新 Enka 数据&rdquo;。
            </p>
          ) : (
            <div className="character-grid">
              {profile.characters.map((character) => (
                <article key={character.id} className="character-card">
                  <img src={character.imageUrl} alt={character.name} loading="lazy" />
                  <div>
                    <h3>{character.name}</h3>
                    <p className="muted">
                      {character.element} · Lv {character.stats.level} · {character.rarity}★
                    </p>
                    <dl className="stat-grid">
                      <div>
                        <dt>攻击</dt>
                        <dd>{character.stats.atk}</dd>
                      </div>
                      <div>
                        <dt>生命</dt>
                        <dd>{character.stats.hp}</dd>
                      </div>
                      <div>
                        <dt>防御</dt>
                        <dd>{character.stats.def}</dd>
                      </div>
                      <div>
                        <dt>暴击率</dt>
                        <dd>{character.stats.critRate}%</dd>
                      </div>
                      <div>
                        <dt>暴伤</dt>
                        <dd>{character.stats.critDmg}%</dd>
                      </div>
                      <div>
                        <dt>充能</dt>
                        <dd>{character.stats.energyRecharge}%</dd>
                      </div>
                      <div>
                        <dt>精通</dt>
                        <dd>{character.stats.elementalMastery}</dd>
                      </div>
                    </dl>
                  </div>
                </article>
              ))}
            </div>
          )}

          <div className="button-row">
            <button
              type="button"
              className="danger"
              onClick={() => void handleDelete(profile.uid)}
            >
              删除该 UID 缓存
            </button>
          </div>
        </>
      )}
    </section>
  );
}
