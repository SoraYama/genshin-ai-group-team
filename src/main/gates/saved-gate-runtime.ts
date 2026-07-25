export interface SavedGateStatus {
  status: 'passed' | 'failed';
}

export function gateExitCode(output: SavedGateStatus): 0 | 1 {
  return output.status === 'passed' ? 0 : 1;
}

export function terminateSavedGate<T extends SavedGateStatus>(
  output: T,
  dependencies: {
    write: (line: string) => void;
    exit: (code: 0 | 1) => void;
  }
): void {
  dependencies.write(`${JSON.stringify(output)}\n`);
  dependencies.exit(gateExitCode(output));
}
