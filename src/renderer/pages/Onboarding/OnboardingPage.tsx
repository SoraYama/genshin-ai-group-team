import { useState } from 'react';
import { api } from '../../ipc';
import type { MiyousheRole } from '../../../shared/domain';
import { ButtonGlyph } from '../../design/Icons';
import { localizeError, useI18n } from '../../i18n';

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
  const { locale, t } = useI18n();
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
          message:
            (locale === 'zh-CN' ? result.message : undefined) ??
            t('onboarding.error.login', { reason: result.reason })
        });
        return;
      }
      setSelectedUid(result.bind.roles[0]?.gameUid);
      setPhase({ kind: 'roles', roles: result.bind.roles, sessionId: result.sessionId });
    } catch (error) {
      setPhase({
        kind: 'error',
        message: localizeError(error, locale, t, 'onboarding.error.loginRequest')
      });
    }
  }

  async function handleValidateManual() {
    const trimmed = cookie.trim();
    if (trimmed.length < 10) {
      setPhase({ kind: 'error', message: t('onboarding.error.cookieIncomplete') });
      return;
    }
    setPhase({ kind: 'validating' });
    setSelectedUid(undefined);
    try {
      const result = await api.miyoushe.bind({ cookie: trimmed });
      if (!result.ok || result.roles.length === 0) {
        setPhase({
          kind: 'error',
          message:
            (locale === 'zh-CN' ? result.message : undefined) ?? t('onboarding.error.cookieInvalid')
        });
        return;
      }
      setSelectedUid(result.roles[0]?.gameUid);
      setPhase({ kind: 'roles', roles: result.roles });
    } catch (error) {
      setPhase({
        kind: 'error',
        message: localizeError(error, locale, t, 'onboarding.error.validation')
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
        message: localizeError(error, locale, t, 'onboarding.error.import')
      });
    }
  }

  const isWorking =
    phase.kind === 'logging-in' || phase.kind === 'validating' || phase.kind === 'importing';

  return (
    <section>
      <h2 className="gta-section-title">
        {t('onboarding.title')}
        <span className="gta-section-sub">ONBOARDING</span>
      </h2>

      <div className="gta-panel" style={{ marginBottom: 'var(--gta-s4)' }}>
        <div className="gta-panel-body">
          <p className="gta-hint">
            {t('onboarding.privacy.before')}
            <strong>{t('onboarding.privacy.strong')}</strong>
            {t('onboarding.privacy.after')}
          </p>

          <div className="gta-actions">
            <button
              type="button"
              className="gta-btn"
              onClick={() => void handleBrowserLogin()}
              disabled={isWorking}
            >
              <span className="gta-btn-icon">
                <ButtonGlyph name="check" />
              </span>
              {phase.kind === 'logging-in'
                ? t('onboarding.waiting')
                : t('onboarding.browserLogin')}
            </button>
          </div>

          <p className="gta-hint" style={{ fontSize: 'var(--gta-text-xs)' }}>
            {t('onboarding.browserHelp.before')} <code>miyoushe.com</code>
            {t('onboarding.browserHelp.after')}
          </p>
        </div>
      </div>

      <details className="gta-disclosure" style={{ marginBottom: 'var(--gta-s4)' }}>
        <summary>{t('onboarding.manual')}</summary>
        <div className="gta-disclosure-body">
          <ol>
            <li>
              {t('onboarding.step1.before')} <code>https://www.miyoushe.com/ys/</code>
            </li>
            <li>
              {t('onboarding.step2.before')} <code>miyoushe.com</code>
            </li>
            <li>
              {t('onboarding.step3.before')} <code>ltoken_v2</code>、<code>ltuid_v2</code>、
              <code>ltmid_v2</code> {t('onboarding.step3.after')}
            </li>
          </ol>
          <label className="gta-field">
            <span className="gta-field-label">Cookie</span>
            <textarea
              className="gta-textarea is-mono"
              value={cookie}
              onChange={(event) => setCookie(event.target.value)}
              placeholder="ltoken_v2=...; ltuid_v2=...; ltmid_v2=..."
              autoComplete="off"
              spellCheck={false}
              rows={3}
            />
          </label>
          <div className="gta-actions">
            <button
              type="button"
              className="gta-btn gta-btn--ghost"
              onClick={() => void handleValidateManual()}
              disabled={isWorking || cookie.trim().length < 10}
            >
              {phase.kind === 'validating'
                ? t('onboarding.validating')
                : t('onboarding.validate')}
            </button>
          </div>
        </div>
      </details>

      {phase.kind === 'error' && <p className="gta-error">{phase.message}</p>}

      {phase.kind === 'roles' && (
        <div className="gta-panel">
          <div className="gta-panel-body">
            <p className="gta-hint">
              {t('onboarding.roles', { count: phase.roles.length })}
            </p>
            <ul className="gta-role-list">
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
                    <span className="gta-role-line">
                      <span className="uid">UID {role.gameUid}</span>
                      {role.nickname && <span className="meta">· {role.nickname}</span>}
                      {role.level !== undefined && (
                        <span className="meta">· Lv.{role.level}</span>
                      )}
                      {role.regionName && <span className="meta">· {role.regionName}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="gta-actions">
              <button
                type="button"
                className="gta-btn"
                onClick={() => void handleImport()}
                disabled={!selectedUid}
              >
                <span className="gta-btn-icon">
                  <ButtonGlyph name="plus" />
                </span>
                {t('onboarding.import')}
              </button>
            </div>
            {phase.sessionId && (
              <p className="gta-hint" style={{ fontSize: 'var(--gta-text-xs)' }}>
                {t('onboarding.sessionExpiry')}
              </p>
            )}
          </div>
        </div>
      )}

      {phase.kind === 'importing' && (
        <p className="gta-hint gta-on-bg">{t('onboarding.importing')}</p>
      )}
    </section>
  );
}
