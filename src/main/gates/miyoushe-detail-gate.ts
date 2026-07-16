import { app } from 'electron';
import { MiyousheClient } from '../services/miyoushe-client.js';
import {
  MiyousheGameRecordClient,
  type MiyousheFetchError,
  type MiyousheRosterCoverage
} from '../services/miyoushe-game-record.js';
import { MiyousheLoginWindow } from '../services/miyoushe-login-window.js';

interface SafeFailure {
  kind: MiyousheFetchError['kind'] | 'roles';
  retcode?: number;
  httpStatus?: number;
}

interface SafeRoleReport {
  uidSuffix: string;
  region: string;
  index:
    | { ok: true; expectedOwnedCount?: number }
    | { ok: false; failure: SafeFailure };
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

  const cookie = await new MiyousheLoginWindow().readPersistedCookie();
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

  const rolesResult = await new MiyousheClient().fetchRoles(cookie);
  if (!rolesResult.ok || rolesResult.roles.length === 0) {
    console.log(
      JSON.stringify(
        {
          gate: 'miyoushe-detail',
          status: 'failed',
          failure: { kind: 'roles', retcode: rolesResult.retcode }
        },
        null,
        2
      )
    );
    return 1;
  }

  const client = new MiyousheGameRecordClient();
  const reports: SafeRoleReport[] = [];
  for (const role of rolesResult.roles) {
    const indexResult = await client.fetchPlayerIndex(role.gameUid, cookie);
    const expectedOwnedCount = indexResult.ok ? indexResult.data.totalCharacters : undefined;
    const rosterResult = await client.fetchDetailedRoster(role.gameUid, cookie, {
      expectedOwnedCount
    });
    reports.push({
      uidSuffix: uidSuffix(role.gameUid),
      region: role.region,
      index: indexResult.ok
        ? { ok: true, expectedOwnedCount }
        : { ok: false, failure: safeFailure(indexResult.error) },
      roster: rosterResult.ok
        ? safeCoverage(rosterResult.data.coverage, expectedOwnedCount)
        : { ok: false, failure: safeFailure(rosterResult.error) }
    });
  }

  const failed = reports.some((report) => !report.index.ok || !report.roster.ok);
  const partial = reports.some((report) => report.roster.ok && report.roster.partial);
  console.log(
    JSON.stringify(
      {
        gate: 'miyoushe-detail',
        status: failed ? 'failed' : partial ? 'partial' : 'passed',
        accountCount: reports.length,
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
