import { readFile as nodeReadFile } from 'node:fs/promises';

import {
  abyssScenarioViewSchema,
  type DevelopmentAbyssScenario,
  type AbyssScenarioView
} from '../../shared/abyss-advisor.js';
import {
  developmentScenarioFixtureSchema,
  type DevelopmentScenarioFixture
} from '../scenario-publication/development-fixture.js';
import type { ScenarioPublicationSnapshot } from '../scenario-publication/contracts.js';

export interface AbyssScenarioServiceOptions {
  enableDevelopmentScenarios: boolean;
  developmentFixturePath: string;
  productionSnapshot?: () => Promise<ScenarioPublicationSnapshot>;
  readFile?: (filePath: string, encoding: 'utf8') => Promise<string>;
  now?: () => Date;
}

export class AbyssScenarioService {
  private readonly readFile: NonNullable<AbyssScenarioServiceOptions['readFile']>;
  private readonly now: () => Date;

  constructor(private readonly options: AbyssScenarioServiceOptions) {
    this.readFile = options.readFile ?? nodeReadFile;
    this.now = options.now ?? (() => new Date());
  }

  async getView(): Promise<AbyssScenarioView> {
    if (this.options.productionSnapshot) {
      const production = await this.readProduction();
      if (production) return production;
    }

    if (this.options.enableDevelopmentScenarios) {
      return this.readDevelopmentSample();
    }

    return {
      status: 'unavailable',
      reason: this.options.productionSnapshot
        ? 'production-data-unavailable'
        : 'production-source-not-configured',
      message: '暂时没有可验证的深境螺旋资料。'
    };
  }

  private async readProduction(): Promise<AbyssScenarioView | undefined> {
    try {
      const snapshot = await this.options.productionSnapshot?.();
      const payload = snapshot?.publication?.payload;
      if (
        !snapshot ||
        snapshot.trustedUse !== 'production' ||
        !payload ||
        payload.mode !== 'spiral-abyss'
      ) {
        return undefined;
      }
      return abyssScenarioViewSchema.parse({
        status: 'ready',
        trust: 'production',
        notCurrent: snapshot.freshness === 'stale' || snapshot.freshness === 'unknown',
        freshness: snapshot.freshness,
        checkedAt: snapshot.checkedAt,
        scenario: payload
      });
    } catch {
      return undefined;
    }
  }

  private async readDevelopmentSample(): Promise<AbyssScenarioView> {
    try {
      const raw = await this.readFile(this.options.developmentFixturePath, 'utf8');
      const fixture = developmentScenarioFixtureSchema.parse(JSON.parse(raw));
      if (!isSpiralDevelopmentFixture(fixture)) {
        throw new Error('Development fixture mode mismatch');
      }
      const scenario: DevelopmentAbyssScenario = {
        ...fixture.scenario,
        meta: fixture.meta
      };
      return abyssScenarioViewSchema.parse({
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

function isSpiralDevelopmentFixture(
  fixture: DevelopmentScenarioFixture
): fixture is Extract<DevelopmentScenarioFixture, { scenario: { mode: 'spiral-abyss' } }> {
  return fixture.scenario.mode === 'spiral-abyss';
}
