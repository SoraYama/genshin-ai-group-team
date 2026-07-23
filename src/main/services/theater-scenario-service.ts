import { readFile as nodeReadFile } from 'node:fs/promises';

import {
  theaterScenarioViewSchema,
  type DevelopmentTheaterScenario,
  type TheaterScenarioView
} from '../../shared/theater-advisor.js';
import {
  developmentScenarioFixtureSchema,
  type DevelopmentScenarioFixture
} from '../scenario-publication/development-fixture.js';
import type { ScenarioPublicationSnapshot } from '../scenario-publication/contracts.js';

export interface TheaterScenarioServiceOptions {
  enableDevelopmentScenarios: boolean;
  developmentFixturePath: string;
  productionSnapshot?: () => Promise<ScenarioPublicationSnapshot>;
  productionUnavailableReason?: 'production-source-not-configured' | 'production-config-invalid';
  readFile?: (filePath: string, encoding: 'utf8') => Promise<string>;
  now?: () => Date;
}

export class TheaterScenarioService {
  private readonly readFile: NonNullable<TheaterScenarioServiceOptions['readFile']>;
  private readonly now: () => Date;

  constructor(private readonly options: TheaterScenarioServiceOptions) {
    this.readFile = options.readFile ?? nodeReadFile;
    this.now = options.now ?? (() => new Date());
  }

  async getView(): Promise<TheaterScenarioView> {
    if (this.options.productionSnapshot) {
      const production = await this.readProduction();
      if (production) return production;
    }
    if (this.options.enableDevelopmentScenarios) return this.readDevelopmentSample();
    const reason =
      this.options.productionUnavailableReason ??
      (this.options.productionSnapshot
        ? 'production-data-unavailable'
        : 'production-source-not-configured');
    return {
      status: 'unavailable',
      reason,
      message:
        reason === 'production-config-invalid'
          ? '正式挑战资料配置无效，已停止加载。'
          : '暂时没有可验证的幻想真境剧诗资料。'
    };
  }

  private async readProduction(): Promise<TheaterScenarioView | undefined> {
    try {
      const snapshot = await this.options.productionSnapshot?.();
      const payload = snapshot?.publication?.payload;
      if (
        !snapshot ||
        (snapshot.status !== 'ready' && snapshot.status !== 'last-known-good') ||
        snapshot.trustedUse !== 'production' ||
        !payload ||
        payload.mode !== 'imaginarium-theater'
      )
        return undefined;
      const usableForRecommendation =
        snapshot.freshness === 'fresh' || snapshot.freshness === 'expiring';
      return theaterScenarioViewSchema.parse({
        status: 'ready',
        trust: 'production',
        snapshotStatus: snapshot.status,
        refreshErrorCode: snapshot.refreshErrorCode,
        notCurrent: !usableForRecommendation,
        usableForRecommendation,
        ...(snapshot.status === 'last-known-good'
          ? { refreshWarning: '正在使用最近一次已确认的资料；本次刷新失败。' }
          : {}),
        freshness: snapshot.freshness,
        checkedAt: snapshot.checkedAt,
        scenario: payload
      });
    } catch {
      return undefined;
    }
  }

  private async readDevelopmentSample(): Promise<TheaterScenarioView> {
    try {
      const fixture = developmentScenarioFixtureSchema.parse(
        JSON.parse(await this.readFile(this.options.developmentFixturePath, 'utf8'))
      );
      if (!isTheaterDevelopmentFixture(fixture)) throw new Error('Fixture mode mismatch');
      const scenario: DevelopmentTheaterScenario = { ...fixture.scenario, meta: fixture.meta };
      return theaterScenarioViewSchema.parse({
        status: 'ready',
        trust: 'development-sample',
        notCurrent: true,
        freshness: 'stale',
        checkedAt: this.now().toISOString(),
        scenario
      });
    } catch {
      return {
        status: 'unavailable',
        reason: 'development-sample-invalid',
        message: '演练资料无法通过完整性检查，已停止使用。'
      };
    }
  }
}

function isTheaterDevelopmentFixture(
  fixture: DevelopmentScenarioFixture
): fixture is Extract<DevelopmentScenarioFixture, { scenario: { mode: 'imaginarium-theater' } }> {
  return fixture.scenario.mode === 'imaginarium-theater';
}
