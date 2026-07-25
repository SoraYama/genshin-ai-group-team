import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const entries = [
  { gate: 'agent-saved', entry: 'dist/main/agent-saved-gate.mjs' },
  { gate: 'advisor-saved', entry: 'dist/main/advisor-saved-gate.mjs' }
];

for (const { gate, entry } of entries) {
  const entryPath = path.join(repositoryRoot, entry);
  assert.equal(existsSync(entryPath), true, `${entry} is missing; run the build before this probe`);
  const userDataDirectory = mkdtempSync(path.join(tmpdir(), `gta-${gate}-empty-`));
  try {
    const childEnvironment = {
      ...process.env,
      GTA_E2E_USER_DATA_DIR: userDataDirectory
    };
    delete childEnvironment.ELECTRON_RUN_AS_NODE;
    delete childEnvironment.GTA_DEV_WATCH;
    const result = spawnSync(electronPath, [entryPath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: childEnvironment,
      timeout: 60_000
    });

    assert.equal(result.error, undefined, `${gate}: ${result.error?.message}`);
    assert.equal(result.signal, null, `${gate}: terminated by ${result.signal}`);
    assert.equal(result.status, 1, `${gate}: expected exit 1; stderr=${result.stderr}`);
    assert.match(
      result.stdout,
      /^[^\r\n]+\r?\n$/u,
      `${gate}: stdout must contain exactly one JSON line`
    );

    const stdoutLines = result.stdout.trim().split(/\r?\n/);
    assert.equal(
      stdoutLines.length,
      1,
      `${gate}: expected exactly one stdout line; stdout=${JSON.stringify(result.stdout)}`
    );
    assert.deepEqual(JSON.parse(stdoutLines[0]), {
      gate,
      status: 'failed',
      code: 'MISSING_SAVED_API_KEY'
    });
  } finally {
    rmSync(userDataDirectory, { recursive: true, force: true });
  }
}

process.stdout.write('saved gate empty-userData process checks passed\n');
