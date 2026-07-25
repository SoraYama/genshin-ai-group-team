import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { gateExitCode, terminateSavedGate } from '../../../src/main/gates/saved-gate-runtime.js';

describe('saved gate runtime', () => {
  it('writes exactly one JSON line synchronously before exiting with the gate status', () => {
    const calls: string[] = [];
    const write = vi.fn((line: string) => {
      calls.push(`write:${line}`);
    });
    const exit = vi.fn((code: 0 | 1) => {
      calls.push(`exit:${code}`);
    });

    terminateSavedGate(
      { gate: 'agent-saved', status: 'failed', code: 'MISSING_SAVED_API_KEY' },
      { write, exit }
    );

    expect(calls).toEqual([
      'write:{"gate":"agent-saved","status":"failed","code":"MISSING_SAVED_API_KEY"}\n',
      'exit:1'
    ]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('maps passed and failed outputs to real process exit codes', () => {
    expect(gateExitCode({ status: 'passed' })).toBe(0);
    expect(gateExitCode({ status: 'failed' })).toBe(1);
  });

  it('keeps both Electron entry points free of deferred exitCode and app.quit', () => {
    for (const relativePath of [
      '../../../src/main/gates/agent-saved-gate.ts',
      '../../../src/main/gates/advisor-saved-gate.ts'
    ]) {
      const source = readFileSync(path.resolve(import.meta.dirname, relativePath), 'utf8');
      expect(source).not.toContain('process.exitCode');
      expect(source).not.toContain('app.quit()');
      expect(source).toContain('terminateSavedGate');
    }
  });
});
