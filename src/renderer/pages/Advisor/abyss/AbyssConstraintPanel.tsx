import type { CharacterProfile } from '../../../../shared/domain';
import type { PlayerPreferences } from '../../../../shared/scenario-v2';
import { GtaButton } from '../../../components/ui/GtaButton';
import {
  characterElementLabel,
  type CharacterInterventionState,
  type PresentationLocale
} from '../abyss-presentation';

interface AbyssConstraintPanelProps {
  locale: PresentationLocale;
  characters: CharacterProfile[];
  search: string;
  preferences: PlayerPreferences;
  interventions: Record<string, CharacterInterventionState>;
  lockedCharacterIds: string[];
  excludedCharacterIds: string[];
  running: boolean;
  blocked: boolean;
  resultNeedsUpdate: boolean;
  canRecomputeHalf: boolean;
  onSearch: (value: string) => void;
  onTogglePreference: (key: keyof PlayerPreferences) => void;
  onCycleCharacter: (id: string) => void;
  onGenerate: (half?: 'firstHalf' | 'secondHalf') => void;
  onCancel: () => void;
}

export function AbyssConstraintPanel({
  locale,
  characters,
  search,
  preferences,
  interventions,
  lockedCharacterIds,
  excludedCharacterIds,
  running,
  blocked,
  resultNeedsUpdate,
  canRecomputeHalf,
  onSearch,
  onTogglePreference,
  onCycleCharacter,
  onGenerate,
  onCancel
}: AbyssConstraintPanelProps) {
  const isEnglish = locale === 'en';
  return (
    <section
      className="abyss-panel abyss-constraint-panel"
      data-testid="abyss-constraints"
      aria-labelledby="abyss-constraints-title"
    >
      <header className="abyss-panel-header">
        <div>
          <span>{isEnglish ? '01 · Constraints' : '01 · 配队约束'}</span>
          <h3 id="abyss-constraints-title">{isEnglish ? 'Roster intervention' : '锁定与排除'}</h3>
        </div>
        <strong>
          {isEnglish
            ? `${lockedCharacterIds.length} locked · ${excludedCharacterIds.length} excluded`
            : `锁定 ${lockedCharacterIds.length} · 排除 ${excludedCharacterIds.length}`}
        </strong>
      </header>

      <div className="abyss-panel-scroll">
        <div
          className="abyss-preference-grid"
          role="group"
          aria-label={isEnglish ? 'Team preferences' : '配队偏好'}
        >
          <PreferenceButton
            label={isEnglish ? 'Simple rotations' : '操作简单'}
            active={preferences.comfort === 'high'}
            disabled={running}
            onClick={() => onTogglePreference('comfort')}
          />
          <PreferenceButton
            label={isEnglish ? 'Prioritize survival' : '生存优先'}
            active={preferences.survival === 'high'}
            disabled={running}
            onClick={() => onTogglePreference('survival')}
          />
          <PreferenceButton
            label={isEnglish ? 'Lower investment' : '低练度'}
            active={preferences.lowInvestment === 'high'}
            disabled={running}
            onClick={() => onTogglePreference('lowInvestment')}
          />
          <PreferenceButton
            label={isEnglish ? 'Keep current builds' : '保持当前配装'}
            active={preferences.noBuildChange}
            disabled={running}
            onClick={() => onTogglePreference('noBuildChange')}
          />
        </div>

        <label className="abyss-roster-search">
          <span className="gta-visually-hidden">
            {isEnglish ? 'Search available characters' : '搜索可用角色'}
          </span>
          <input
            type="search"
            aria-label={isEnglish ? 'Search available characters' : '搜索可用角色'}
            placeholder={isEnglish ? 'Filter roster' : '筛选角色'}
            value={search}
            onChange={(event) => onSearch(event.target.value)}
          />
          <span>{isEnglish ? `${characters.length} shown` : `显示 ${characters.length} 名`}</span>
        </label>

        <div
          className="abyss-roster-grid"
          aria-label={isEnglish ? 'Character choices' : '角色干预'}
        >
          {characters.map((character) => (
            <CharacterButton
              key={character.id}
              character={character}
              locale={locale}
              state={interventions[String(character.id)] ?? 'neutral'}
              disabled={running}
              onClick={() => onCycleCharacter(String(character.id))}
            />
          ))}
        </div>
      </div>

      <footer className="abyss-panel-actions">
        <div className="abyss-selection-summary" aria-live="polite">
          <span>{isEnglish ? 'Selection' : '已选摘要'}</span>
          <strong>
            {lockedCharacterIds.length === 0 && excludedCharacterIds.length === 0
              ? isEnglish
                ? 'No manual intervention'
                : '未干预角色'
              : isEnglish
                ? `${lockedCharacterIds.length}/8 locked`
                : `${lockedCharacterIds.length}/8 已锁定`}
          </strong>
        </div>
        <div className="abyss-run-actions">
          {resultNeedsUpdate && canRecomputeHalf ? (
            <>
              <GtaButton onClick={() => onGenerate('firstHalf')} disabled={running || blocked}>
                {isEnglish ? 'Recalculate first half' : '只重算上半'}
              </GtaButton>
              <GtaButton onClick={() => onGenerate('secondHalf')} disabled={running || blocked}>
                {isEnglish ? 'Recalculate second half' : '只重算下半'}
              </GtaButton>
              <GtaButton tone="ghost" onClick={() => onGenerate()} disabled={running || blocked}>
                {isEnglish ? 'Recalculate both teams' : '完整重算'}
              </GtaButton>
            </>
          ) : (
            <GtaButton onClick={() => onGenerate()} disabled={running || blocked}>
              {running
                ? isEnglish
                  ? 'Building both teams…'
                  : '正在生成双队…'
                : isEnglish
                  ? 'Generate both teams'
                  : '生成上下半方案'}
            </GtaButton>
          )}
          {running && (
            <GtaButton tone="ghost" onClick={onCancel}>
              {isEnglish ? 'Cancel generation' : '取消生成'}
            </GtaButton>
          )}
        </div>
      </footer>
    </section>
  );
}

function PreferenceButton({
  label,
  active,
  disabled,
  onClick
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" aria-pressed={active} disabled={disabled} onClick={onClick}>
      <span aria-hidden="true">{active ? '◆' : '◇'}</span>
      {label}
    </button>
  );
}

function CharacterButton({
  character,
  locale,
  state,
  disabled,
  onClick
}: {
  character: CharacterProfile;
  locale: PresentationLocale;
  state: CharacterInterventionState;
  disabled: boolean;
  onClick: () => void;
}) {
  const isEnglish = locale === 'en';
  const stateLabel =
    state === 'locked'
      ? isEnglish
        ? 'Locked'
        : '锁定'
      : state === 'excluded'
        ? isEnglish
          ? 'Excluded'
          : '排除'
        : isEnglish
          ? 'Neutral'
          : '未设置';
  return (
    <button
      type="button"
      className={`gta-abyss-character is-${state}`}
      aria-label={
        isEnglish
          ? `${character.name}, current state: ${stateLabel}; press to change`
          : `${character.name}，当前：${stateLabel}；按下切换`
      }
      aria-pressed={state === 'locked'}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="abyss-avatar" aria-hidden="true">
        {character.name.slice(0, 1)}
      </span>
      <span>
        <strong>{character.name}</strong>
        <small>
          {characterElementLabel(character.element, locale)} · {character.level ?? '—'}
        </small>
      </span>
      <em>{state === 'locked' ? '◆' : state === 'excluded' ? '×' : '·'}</em>
    </button>
  );
}
