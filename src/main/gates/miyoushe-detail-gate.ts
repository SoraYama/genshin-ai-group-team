import path from 'node:path';
import { app, session } from 'electron';
import { MiyousheClient } from '../services/miyoushe-client.js';
import { MiyousheCalculatorClient } from '../services/miyoushe-calculator.js';
import {
  MiyousheGameRecordClient,
  type MiyousheDeviceRecoveryEvent,
  type MiyousheFetchError,
  type MiyousheRosterCoverage
} from '../services/miyoushe-game-record.js';
import {
  MIYOUSHE_LOGIN_PARTITION,
  MiyousheLoginWindow
} from '../services/miyoushe-login-window.js';
import { createMiyousheBrowserTransport } from '../services/miyoushe/browser-transport.js';
import { MiyousheDeviceFpRecoveryStore } from '../services/miyoushe/device-fp-recovery-store.js';
import { MiyousheDeviceFpService, type DeviceFpResult } from '../services/miyoushe/device-fp.js';

// `electron dist/main/miyoushe-detail-gate.mjs` does not load package.json as
// the application entry, so Electron otherwise uses the shared "Electron"
// userData directory. Point the opt-in gate at the same dev profile as
// `electron .`; this keeps it from reading unrelated apps' cookie partitions.
if (!app.isPackaged && !process.env.GTA_E2E_USER_DATA_DIR) {
  app.setPath('userData', path.join(app.getPath('appData'), 'genshin-team-advisor'));
}

interface SafeFailure {
  kind: MiyousheFetchError['kind'] | 'roles';
  retcode?: number;
  httpStatus?: number;
}

interface SafeRoleReport {
  uidSuffix: string;
  region: string;
  index: { ok: true; expectedOwnedCount?: number } | { ok: false; failure: SafeFailure };
  roster:
    | {
        ok: true;
        listedCount: number;
        detailedCount: number;
        consistency: 'match' | 'mismatch' | 'unknown';
        missingCount: number;
        duplicateCount: number;
        unexpectedCount: number;
        failedBatches: MiyousheRosterCoverage['failedBatches'];
        fields: MiyousheRosterCoverage['fields'];
        partial: boolean;
      }
    | { ok: false; failure: SafeFailure };
  calculator:
    | {
        attempted: true;
        ok: true;
        listedCount: number;
        detailedCount: number;
        partial: boolean;
        fields: MiyousheRosterCoverage['fields'];
      }
    | { attempted: true; ok: false; failure: SafeFailure }
    | { attempted: false };
}

type SafeEnsureOutcome = 'unchanged' | 'refreshed' | 'cooldown' | 'failed';

interface SafeDeviceFpReport {
  profileComplete: boolean;
  ensure: SafeEnsureOutcome;
  recoveryEvents: MiyousheDeviceRecoveryEvent[];
}

const REQUIRED_DEVICE_COOKIE_NAMES = [
  '_MHYUUID',
  'DEVICEFP',
  'DEVICEFP_SEED_ID',
  'DEVICEFP_SEED_TIME'
] as const;

function hasCompleteDeviceProfile(cookie: string): boolean {
  const names = new Set(
    cookie.split(';').flatMap((part) => {
      const separator = part.indexOf('=');
      if (separator <= 0 || !part.slice(separator + 1).trim()) return [];
      return [part.slice(0, separator).trim()];
    })
  );
  return REQUIRED_DEVICE_COOKIE_NAMES.every((name) => names.has(name));
}

function safeFailure(error: MiyousheFetchError): SafeFailure {
  return {
    kind: error.kind,
    retcode: 'retcode' in error ? error.retcode : undefined,
    httpStatus: 'httpStatus' in error ? error.httpStatus : undefined
  };
}

function uidSuffix(uid: string): string {
  return uid.slice(-3).padStart(3, '*');
}

function safeCoverage(
  coverage: MiyousheRosterCoverage,
  expectedOwnedCount?: number
): Extract<SafeRoleReport['roster'], { ok: true }> {
  return {
    ok: true,
    listedCount: coverage.listedCount,
    detailedCount: coverage.detailedCount,
    consistency:
      expectedOwnedCount === undefined
        ? 'unknown'
        : expectedOwnedCount === coverage.listedCount
          ? 'match'
          : 'mismatch',
    missingCount: coverage.missingCharacterIds.length,
    duplicateCount: coverage.duplicateCharacterIds.length,
    unexpectedCount: coverage.unexpectedCharacterIds.length,
    failedBatches: coverage.failedBatches,
    fields: coverage.fields,
    partial: coverage.partial
  };
}

async function run(): Promise<number> {
  await app.whenReady();

  const loginWindow = new MiyousheLoginWindow();
  const cookie = await loginWindow.readPersistedCookie();
  if (!cookie) {
    console.log(
      JSON.stringify(
        {
          gate: 'miyoushe-detail',
          status: 'skipped',
          reason: 'no-persisted-login',
          next: '先在应用内完成米游社登录，再重新运行 npm run gate:miyoushe-detail'
        },
        null,
        2
      )
    );
    return 0;
  }

  const recoveryEvents: MiyousheDeviceRecoveryEvent[] = [];
  const browserTransport = createMiyousheBrowserTransport(
    session.fromPartition(MIYOUSHE_LOGIN_PARTITION)
  );
  const cooldown = new MiyousheDeviceFpRecoveryStore();
  const deviceFp = new MiyousheDeviceFpService({
    cookieWriter: loginWindow,
    cooldown
  });

  let effectiveCookie = cookie;
  let ensure: SafeEnsureOutcome = 'failed';
  let ensureResult: DeviceFpResult | undefined;
  try {
    ensureResult = await deviceFp.ensureForSession(cookie);
    effectiveCookie = ensureResult.cookie;
    ensure = ensureResult.ok
      ? ensureResult.refreshed
        ? 'refreshed'
        : 'unchanged'
      : ensureResult.reason === 'cooldown'
        ? 'cooldown'
        : 'failed';
  } catch {
    // The gate remains useful for calculator fallback even if device setup fails.
  }
  const safeDeviceFp: SafeDeviceFpReport = {
    profileComplete: hasCompleteDeviceProfile(effectiveCookie),
    ensure,
    recoveryEvents
  };
  let recoveryInFlight: Promise<DeviceFpResult> | undefined;
  const gateDeviceFp = {
    applyKnownFingerprint: (requestCookie: string) => deviceFp.applyKnownFingerprint(requestCookie),
    recoverFrom5003: (requestCookie: string): Promise<DeviceFpResult> => {
      if (ensureResult && !ensureResult.ok) return Promise.resolve(ensureResult);
      if (!ensureResult) {
        return Promise.resolve({ ok: false, cookie: effectiveCookie, reason: 'network' });
      }
      // Memoize success and failure alike: one gate process may inspect several
      // UIDs, but it is allowed to start at most one recovery after startup ensure.
      recoveryInFlight ??= deviceFp.recoverFrom5003(requestCookie);
      return recoveryInFlight;
    },
    finishReplay: (requestCookie: string, outcome: 'success' | '5003' | 'other-error') =>
      deviceFp.finishReplay(requestCookie, outcome)
  };

  const rolesResult = await new MiyousheClient().fetchRoles(effectiveCookie);
  if (!rolesResult.ok || rolesResult.roles.length === 0) {
    console.log(
      JSON.stringify(
        {
          gate: 'miyoushe-detail',
          status: 'failed',
          failure: { kind: 'roles', retcode: rolesResult.retcode },
          deviceFp: safeDeviceFp
        },
        null,
        2
      )
    );
    return 1;
  }

  const client = new MiyousheGameRecordClient({
    browserTransport,
    deviceFp: gateDeviceFp,
    onDeviceRecoveryEvent: (event) => recoveryEvents.push(event)
  });
  const calculator = new MiyousheCalculatorClient();
  const reports: SafeRoleReport[] = [];
  for (const role of rolesResult.roles) {
    const indexResult = await client.fetchPlayerIndex(role.gameUid, effectiveCookie);
    const expectedOwnedCount = indexResult.ok ? indexResult.data.totalCharacters : undefined;
    const rosterResult = await client.fetchDetailedRoster(role.gameUid, effectiveCookie, {
      expectedOwnedCount
    });
    const needsCalculator =
      !indexResult.ok || !rosterResult.ok || rosterResult.data.coverage.partial;
    const calculatorResult = needsCalculator
      ? await calculator.fetchOwnedRoster(role.gameUid, effectiveCookie)
      : undefined;
    reports.push({
      uidSuffix: uidSuffix(role.gameUid),
      region: role.region,
      index: indexResult.ok
        ? { ok: true, expectedOwnedCount }
        : { ok: false, failure: safeFailure(indexResult.error) },
      roster: rosterResult.ok
        ? safeCoverage(rosterResult.data.coverage, expectedOwnedCount)
        : { ok: false, failure: safeFailure(rosterResult.error) },
      calculator:
        calculatorResult === undefined
          ? { attempted: false }
          : calculatorResult.ok
            ? {
                attempted: true,
                ok: true,
                listedCount: calculatorResult.data.coverage.listedCount,
                detailedCount: calculatorResult.data.coverage.detailedCount,
                partial: calculatorResult.data.coverage.partial,
                fields: calculatorResult.data.coverage.fields
              }
            : {
                attempted: true,
                ok: false,
                failure: safeFailure(calculatorResult.error)
              }
    });
  }

  const resolved = (report: SafeRoleReport): boolean =>
    (report.index.ok && report.roster.ok && !report.roster.partial) ||
    (report.calculator.attempted && report.calculator.ok && !report.calculator.partial);
  const failed = reports.some((report) => !resolved(report));
  const partial =
    !failed &&
    reports.some(
      (report) =>
        (report.roster.ok && report.roster.partial) ||
        (report.calculator.attempted && report.calculator.ok && report.calculator.partial)
    );
  console.log(
    JSON.stringify(
      {
        gate: 'miyoushe-detail',
        status: failed ? 'failed' : partial ? 'partial' : 'passed',
        accountCount: reports.length,
        deviceFp: safeDeviceFp,
        reports
      },
      null,
      2
    )
  );
  return failed || partial ? 1 : 0;
}

void run()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(
      JSON.stringify({
        gate: 'miyoushe-detail',
        status: 'failed',
        failure: { kind: 'unexpected', name: error instanceof Error ? error.name : 'Error' }
      })
    );
    process.exitCode = 1;
  })
  .finally(() => {
    app.quit();
  });
