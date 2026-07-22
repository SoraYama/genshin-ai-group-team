import { useState } from 'react';
import type { MiyousheRole } from '../../../shared/domain';
import { ButtonGlyph } from '../../design/Icons';
import { api } from '../../ipc';
import { localizeError, useI18n } from '../../i18n';

interface OnboardingPageProps {
  onBound: (uid: string) => void;
  onCancel?: () => void;
}

type Method = 'account' | 'uid' | null;
type Phase =
  | { kind: 'idle' }
  | { kind: 'logging-in' }
  | { kind: 'validating' }
  | { kind: 'roles'; roles: MiyousheRole[]; sessionId?: string }
  | { kind: 'syncing' }
  | { kind: 'error'; message: string };

export function OnboardingPage({ onBound, onCancel }: OnboardingPageProps) {
  const { locale, t } = useI18n();
  const [method, setMethod] = useState<Method>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [uid, setUid] = useState('');
  const [cookie, setCookie] = useState('');
  const [selectedUid, setSelectedUid] = useState<string>();

  const working = ['logging-in', 'validating', 'syncing'].includes(phase.kind);

  function choose(next: Exclude<Method, null>) {
    setMethod(next);
    setPhase({ kind: 'idle' });
    setSelectedUid(undefined);
  }

  function backToMethods() {
    if (working) return;
    setMethod(null);
    setPhase({ kind: 'idle' });
    setSelectedUid(undefined);
  }

  async function handleBrowserLogin() {
    setPhase({ kind: 'logging-in' });
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

  async function handleUidSync() {
    const normalized = uid.trim();
    if (!/^\d{9}$/.test(normalized)) {
      setPhase({ kind: 'error', message: t('onboarding.error.uid') });
      return;
    }
    setPhase({ kind: 'syncing' });
    try {
      const outcome = await api.profile.refresh({ uid: normalized });
      await api.profile.setActive({ uid: outcome.profile.uid });
      onBound(outcome.profile.uid);
    } catch (error) {
      setPhase({
        kind: 'error',
        message: localizeError(error, locale, t, 'onboarding.error.uidSync')
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

  async function handleAccountImport() {
    if (phase.kind !== 'roles' || !selectedUid) return;
    const sessionId = phase.sessionId;
    setPhase({ kind: 'syncing' });
    try {
      const profile = sessionId
        ? await api.profile.importFromSession({ sessionId, uid: selectedUid })
        : await api.profile.importFromCookie({ cookie: cookie.trim(), uid: selectedUid });
      onBound(profile.uid);
    } catch (error) {
      setPhase({
        kind: 'error',
        message: localizeError(error, locale, t, 'onboarding.error.import')
      });
    }
  }

  const currentStep = method === null ? 1 : phase.kind === 'roles' ? 3 : 2;

  return (
    <section className="gta-onboarding-page">
      <header className="gta-onboarding-heading">
        <div>
          <span className="gta-kicker">{t('onboarding.kicker')}</span>
          <h2 className="gta-section-title">{t('onboarding.title')}</h2>
          <p>{t('onboarding.intro')}</p>
        </div>
        {onCancel && (
          <button type="button" className="gta-text-action" onClick={onCancel}>
            {t('onboarding.cancel')}
          </button>
        )}
      </header>

      <ol className="gta-onboarding-steps" aria-label={t('onboarding.stepsLabel')}>
        {([1, 2, 3] as const).map((step) => (
          <li
            key={step}
            className={step === currentStep ? 'is-current' : step < currentStep ? 'is-done' : ''}
          >
            <span>{step}</span>
            {t(`onboarding.step.${step}`)}
          </li>
        ))}
      </ol>

      {method === null ? (
        <div className="gta-onboarding-methods">
          <button
            type="button"
            className="gta-onboarding-method is-recommended"
            onClick={() => choose('account')}
          >
            <span className="gta-onboarding-method-icon" aria-hidden="true">
              ✦
            </span>
            <strong>{t('onboarding.method.account')}</strong>
            <span>{t('onboarding.method.accountDetail')}</span>
            <small>{t('onboarding.recommended')}</small>
          </button>
          <button type="button" className="gta-onboarding-method" onClick={() => choose('uid')}>
            <span className="gta-onboarding-method-icon" aria-hidden="true">
              ◇
            </span>
            <strong>{t('onboarding.method.uid')}</strong>
            <span>{t('onboarding.method.uidDetail')}</span>
          </button>
        </div>
      ) : method === 'uid' ? (
        <div className="gta-onboarding-workspace">
          <div className="gta-onboarding-copy">
            <h3>{t('onboarding.uid.title')}</h3>
            <p>{t('onboarding.uid.body')}</p>
          </div>
          <label className="gta-field gta-onboarding-uid-field">
            <span className="gta-field-label">{t('onboarding.uid.label')}</span>
            <input
              value={uid}
              inputMode="numeric"
              autoComplete="off"
              maxLength={9}
              pattern="[0-9]{9}"
              onChange={(event) => {
                setUid(event.target.value.replace(/\D/g, '').slice(0, 9));
                if (phase.kind === 'error') setPhase({ kind: 'idle' });
              }}
              placeholder="100000001"
              disabled={working}
            />
          </label>
          <p className="gta-onboarding-note">{t('onboarding.uid.note')}</p>
          <OnboardingActions
            back={backToMethods}
            backLabel={t('onboarding.back')}
            disabled={working}
            primaryLabel={
              phase.kind === 'syncing' ? t('onboarding.syncing') : t('onboarding.uid.action')
            }
            onPrimary={() => void handleUidSync()}
          />
        </div>
      ) : phase.kind === 'roles' ? (
        <div className="gta-onboarding-workspace">
          <div className="gta-onboarding-copy">
            <h3>{t('onboarding.rolesTitle')}</h3>
            <p>{t('onboarding.roles', { count: phase.roles.length })}</p>
          </div>
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
                    <strong>{role.nickname ?? t('roster.unnamedAccount')}</strong>
                    <span className="uid">UID {role.gameUid}</span>
                    {role.level !== undefined && <span className="meta">Lv.{role.level}</span>}
                    {role.regionName && <span className="meta">{role.regionName}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <OnboardingActions
            back={backToMethods}
            backLabel={t('onboarding.back')}
            disabled={!selectedUid}
            primaryLabel={t('onboarding.import')}
            onPrimary={() => void handleAccountImport()}
          />
        </div>
      ) : (
        <div className="gta-onboarding-workspace">
          <div className="gta-onboarding-copy">
            <h3>{t('onboarding.account.title')}</h3>
            <p>{t('onboarding.account.body')}</p>
          </div>
          <button
            type="button"
            className="gta-btn"
            onClick={() => void handleBrowserLogin()}
            disabled={working}
          >
            <span className="gta-btn-icon">
              <ButtonGlyph name="check" />
            </span>
            {phase.kind === 'logging-in' ? t('onboarding.waiting') : t('onboarding.browserLogin')}
          </button>
          <p className="gta-onboarding-note">{t('onboarding.privacySimple')}</p>
          <details className="gta-disclosure gta-onboarding-advanced">
            <summary>{t('onboarding.manual')}</summary>
            <div className="gta-disclosure-body">
              <p>{t('onboarding.manualHelp')}</p>
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
              <button
                type="button"
                className="gta-btn gta-btn--ghost"
                onClick={() => void handleValidateManual()}
                disabled={working || cookie.trim().length < 10}
              >
                {phase.kind === 'validating'
                  ? t('onboarding.validating')
                  : t('onboarding.validate')}
              </button>
            </div>
          </details>
          <button
            type="button"
            className="gta-text-action"
            onClick={backToMethods}
            disabled={working}
          >
            {t('onboarding.back')}
          </button>
        </div>
      )}

      {phase.kind === 'error' && (
        <p className="gta-error gta-onboarding-error" role="alert">
          {phase.message}
        </p>
      )}
      {phase.kind === 'syncing' && (
        <div className="gta-onboarding-sync" role="status">
          <span className="gta-onboarding-pulse" aria-hidden="true" />
          <div>
            <strong>{t('onboarding.syncing')}</strong>
            <p>{t('onboarding.syncingDetail')}</p>
          </div>
        </div>
      )}
    </section>
  );
}

function OnboardingActions({
  back,
  backLabel,
  disabled,
  onPrimary,
  primaryLabel
}: {
  back: () => void;
  backLabel: string;
  disabled: boolean;
  onPrimary: () => void;
  primaryLabel: string;
}) {
  return (
    <div className="gta-onboarding-actions">
      <button type="button" className="gta-text-action" onClick={back} disabled={disabled}>
        {backLabel}
      </button>
      <button type="button" className="gta-btn" onClick={onPrimary} disabled={disabled}>
        {primaryLabel}
      </button>
    </div>
  );
}
