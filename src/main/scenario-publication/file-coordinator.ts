import path from 'node:path';

import type { ScenarioPublicationUse } from './contracts.js';

const scenarioDataFileQueues = new Map<string, Promise<void>>();

/**
 * Coordinates whole-file workflows that may span several storage operations
 * (for example load -> network fetch -> save) with data-management deletion.
 */
export function runScenarioDataFilesExclusive<T>(
  cacheDirectory: string,
  use: ScenarioPublicationUse,
  operation: () => Promise<T>
): Promise<T> {
  const queueKey = JSON.stringify([path.resolve(cacheDirectory), use]);
  const previous = scenarioDataFileQueues.get(queueKey) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  scenarioDataFileQueues.set(queueKey, tail);
  void tail.then(() => {
    if (scenarioDataFileQueues.get(queueKey) === tail) {
      scenarioDataFileQueues.delete(queueKey);
    }
  });
  return run;
}
