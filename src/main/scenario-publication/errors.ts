export type ScenarioPublicationErrorCode =
  | 'not-found'
  | 'network-unavailable'
  | 'invalid-json'
  | 'manifest-invalid'
  | 'schema-invalid'
  | 'unsupported-schema-version'
  | 'digest-mismatch'
  | 'unknown-signing-key'
  | 'bad-signature'
  | 'identity-mismatch'
  | 'storage-read-failed'
  | 'storage-write-failed';

const SAFE_MESSAGES: Record<ScenarioPublicationErrorCode, string> = {
  'not-found': 'Scenario publication was not found.',
  'network-unavailable': 'Scenario publication could not be reached.',
  'invalid-json': 'Scenario publication contains invalid JSON.',
  'manifest-invalid': 'Scenario publication manifest is invalid.',
  'schema-invalid': 'Scenario publication does not match the supported schema.',
  'unsupported-schema-version': 'Scenario publication requires a newer app version.',
  'digest-mismatch': 'Scenario publication digest verification failed.',
  'unknown-signing-key': 'Scenario publication uses an unknown signing key.',
  'bad-signature': 'Scenario publication signature verification failed.',
  'identity-mismatch': 'Scenario publication identity does not match its manifest.',
  'storage-read-failed': 'Saved scenario data could not be read.',
  'storage-write-failed': 'Scenario data could not be saved safely.'
};

export class ScenarioPublicationError extends Error {
  readonly code: ScenarioPublicationErrorCode;

  constructor(code: ScenarioPublicationErrorCode, _options?: { cause?: unknown }) {
    super(SAFE_MESSAGES[code]);
    this.name = 'ScenarioPublicationError';
    this.code = code;
  }
}

export function asScenarioPublicationError(error: unknown): ScenarioPublicationError {
  return error instanceof ScenarioPublicationError
    ? error
    : new ScenarioPublicationError('network-unavailable', { cause: error });
}
