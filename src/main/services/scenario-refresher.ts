import type { ScenarioStore } from './scenario-store.js';

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class ScenarioRefresher {
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;

  constructor(
    private readonly store: ScenarioStore,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS
  ) {}

  start(): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async runOnce(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const refreshed = await this.store.refresh();
      if (refreshed.length > 0) {
        console.info('[scenario-refresher] refreshed:', refreshed.join(', '));
      }
    } finally {
      this.inFlight = false;
    }
  }
}
