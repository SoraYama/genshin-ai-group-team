import type { AbyssScenarioView } from '../../../../shared/abyss-advisor';
import type { EnemyInstance, EnemyWave } from '../../../../shared/scenario-v2';
import { enemyDisplayName, mechanicLabels, type PresentationLocale } from '../abyss-presentation';

interface AbyssScenarioPanelProps {
  locale: PresentationLocale;
  scenarioView: Extract<AbyssScenarioView, { status: 'ready' }>;
  floorNumber: number | null;
  chamberNumber: number | 'all';
  selectedChambers: Array<{
    chamber: number;
    firstHalf: { waves: EnemyWave[] };
    secondHalf: { waves: EnemyWave[] };
    targetSeconds?: number;
  }>;
  running: boolean;
  readOnly: boolean;
  onChooseFloor: (floor: number) => void;
  onChooseChamber: (chamber: number | 'all') => void;
}

export function AbyssScenarioPanel({
  locale,
  scenarioView,
  floorNumber,
  chamberNumber,
  selectedChambers,
  running,
  readOnly,
  onChooseFloor,
  onChooseChamber
}: AbyssScenarioPanelProps) {
  const isEnglish = locale === 'en';
  const scenario = scenarioView.scenario;
  const floor = scenario.floors.find(({ floor: value }) => value === floorNumber);
  const status =
    scenarioView.trust === 'development-sample'
      ? isEnglish
        ? 'Practice snapshot'
        : '演练资料'
      : scenarioView.freshness === 'fresh'
        ? isEnglish
          ? 'Verified fresh'
          : '已验证 · 最新'
        : isEnglish
          ? 'Verified snapshot'
          : '已验证快照';

  return (
    <section
      className="abyss-panel abyss-scenario-panel"
      data-testid="abyss-scenario"
      aria-labelledby="abyss-scenario-title"
    >
      <header className="abyss-panel-header">
        <div>
          <span>{isEnglish ? '02 · Scenario' : '02 · 敌情场景'}</span>
          <h3 id="abyss-scenario-title">{isEnglish ? 'Floor and chamber' : '楼层与房间'}</h3>
        </div>
        <strong>{status}</strong>
      </header>

      <div className="abyss-scenario-selectors">
        <div role="group" aria-label={isEnglish ? 'Choose floor' : '选择楼层'}>
          {scenario.floors.map(({ floor: value }) => (
            <button
              key={value}
              type="button"
              disabled={running}
              aria-pressed={floorNumber === value}
              onClick={() => onChooseFloor(value)}
            >
              {isEnglish ? `Floor ${value}` : `${value} 层`}
            </button>
          ))}
        </div>
        <label>
          <span>{isEnglish ? 'Target chamber' : '目标房间'}</span>
          <select
            disabled={running}
            value={chamberNumber}
            onChange={(event) =>
              onChooseChamber(event.target.value === 'all' ? 'all' : Number(event.target.value))
            }
          >
            <option value="all">{isEnglish ? 'All chambers' : '全部房间'}</option>
            {floor?.chambers.map(({ chamber }) => (
              <option key={chamber} value={chamber}>
                {isEnglish ? `Chamber ${chamber}` : `第 ${chamber} 间`}
              </option>
            ))}
          </select>
        </label>
      </div>

      {readOnly && (
        <p className="abyss-scenario-block" role="alert">
          {isEnglish
            ? 'This snapshot is outdated. Generation is unavailable until verified data returns.'
            : '资料已过期：当前仅可查看敌情，恢复可信资料后才能生成。'}
        </p>
      )}

      <div className="abyss-panel-scroll abyss-enemy-columns">
        <ScenarioHalf
          title={isEnglish ? 'First half' : '上半敌情'}
          half="first"
          chambers={selectedChambers}
          locale={locale}
        />
        <ScenarioHalf
          title={isEnglish ? 'Second half' : '下半敌情'}
          half="second"
          chambers={selectedChambers}
          locale={locale}
        />
      </div>

      <footer className="abyss-scenario-meta">
        <span>
          {scenarioView.trust === 'development-sample'
            ? isEnglish
              ? 'Practice blessing'
              : '演练增益'
            : isEnglish
              ? 'Current blessing'
              : '本期祝福'}
        </span>
        <p>
          {isEnglish && /[\u3400-\u9fff]/u.test(scenario.blessing.description)
            ? 'Blessing details are available in the published challenge data.'
            : scenario.blessing.description}
        </p>
        <code>{scenario.meta.dataVersion.replace(/^development\./u, '')}</code>
      </footer>
    </section>
  );
}

function ScenarioHalf({
  title,
  half,
  chambers,
  locale
}: {
  title: string;
  half: 'first' | 'second';
  chambers: AbyssScenarioPanelProps['selectedChambers'];
  locale: PresentationLocale;
}) {
  const isEnglish = locale === 'en';
  return (
    <section className={`gta-abyss-half gta-abyss-half--${half}`}>
      <h4>{title}</h4>
      {chambers.map((chamber) => (
        <div key={chamber.chamber} className="gta-abyss-chamber">
          <div className="gta-abyss-chamber-title">
            <strong>{isEnglish ? `Chamber ${chamber.chamber}` : `第 ${chamber.chamber} 间`}</strong>
            {chamber.targetSeconds && (
              <span>
                {isEnglish ? `${chamber.targetSeconds}s target` : `${chamber.targetSeconds} 秒`}
              </span>
            )}
          </div>
          {(half === 'first' ? chamber.firstHalf.waves : chamber.secondHalf.waves).map(
            (wave, waveIndex) => (
              <div key={wave.id} className="gta-abyss-wave">
                <span className="gta-abyss-wave-index">
                  {isEnglish ? `Wave ${waveIndex + 1}` : `第 ${waveIndex + 1} 波`}
                </span>
                {wave.enemies.map((enemy) => (
                  <EnemyRow key={enemy.enemy.id} enemy={enemy} locale={locale} />
                ))}
              </div>
            )
          )}
        </div>
      ))}
    </section>
  );
}

function EnemyRow({ enemy, locale }: { enemy: EnemyInstance; locale: PresentationLocale }) {
  const labels = mechanicLabels(enemy.mechanics, locale);
  return (
    <article className="gta-abyss-enemy">
      <div>
        <strong>{enemyDisplayName(enemy, locale)}</strong>
        <span>
          ×{enemy.count} · Lv.{enemy.level}
        </span>
      </div>
      <ul>
        {(labels.length > 0 ? labels : [locale === 'en' ? 'No marked mechanic' : '无特殊机制']).map(
          (label) => (
            <li key={label}>{label}</li>
          )
        )}
      </ul>
    </article>
  );
}
