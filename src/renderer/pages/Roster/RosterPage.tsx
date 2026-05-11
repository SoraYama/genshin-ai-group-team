import { useCallback, useEffect, useState } from 'react';
import { api } from '../../ipc';
import type {
  CharacterProfile,
  PersistedProfile,
  ProfileStateView
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
  | { kind: 'loading' }
  | { kind: 'error'; message: string };

const SOURCE_LABEL: Record<PersistedProfile['source'], string> = {
  miyoushe: '米游社',
  'miyoushe+enka': '米游社 + Enka',
  enka: 'Enka'
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
                    {status.kind === 'loading' ? '刷新中…' : '刷新 Enka'}
                  </button>
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
