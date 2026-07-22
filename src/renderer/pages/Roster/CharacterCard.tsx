import { useState } from 'react';
import type { CharacterProfile, CharacterStats } from '../../../shared/domain';
import { BuildIcon, ElementIcon, StarIcon, StatIcon, type StatIconName } from '../../design/Icons';
import { elementPalette, normalizeElement, type Element } from '../../design/tokens';
import { useI18n, type TranslationKey } from '../../i18n';

interface CharacterCardProps {
  character: CharacterProfile;
}

const statRows: Array<{
  key: keyof CharacterStats;
  icon: StatIconName;
  label: TranslationKey;
  suffix?: string;
}> = [
  { key: 'hp', icon: 'hp', label: 'roster.hp' },
  { key: 'atk', icon: 'atk', label: 'roster.atk' },
  { key: 'def', icon: 'def', label: 'roster.def' },
  { key: 'critRate', icon: 'crit-rate', label: 'roster.critRate', suffix: '%' },
  { key: 'critDmg', icon: 'crit-dmg', label: 'roster.critDmg', suffix: '%' },
  {
    key: 'energyRecharge',
    icon: 'energy-recharge',
    label: 'roster.energyRecharge',
    suffix: '%'
  },
  { key: 'elementalMastery', icon: 'elemental-mastery', label: 'roster.elementalMastery' }
];

export function CharacterCard({ character }: CharacterCardProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const element = normalizeElement(character.element);
  const stars = Math.max(1, Math.min(5, character.rarity));
  const completenessLabel = {
    basic: t('roster.basic'),
    build: t('roster.build'),
    detailed: t('roster.detailed')
  }[character.completeness];

  return (
    <article className={`gta-character r${stars}`} data-element={element}>
      <div className="gta-character-main">
        <IdentityMark name={character.name} element={element} />
        <div className="gta-character-identity">
          <div className="gta-character-title-row">
            <h3 className="gta-name">{character.name}</h3>
            <span className="gta-tag">{completenessLabel}</span>
          </div>
          <div className="gta-character-facts">
            <span>{t('roster.levelShort', { level: character.level ?? '—' })}</span>
            <span title={t('roster.constellation')}>
              <BuildIcon name="constellation" />
              {t('roster.constellationValue', { count: character.constellation ?? '—' })}
            </span>
            <span title={t('roster.element')}>
              <ElementIcon element={element} size={16} />
              {t(`roster.element.${element}`)}
            </span>
            <span title={t('roster.rarity')}>
              <span className="gta-character-stars" aria-hidden="true">
                {Array.from({ length: stars }, (_, index) => (
                  <StarIcon key={index} />
                ))}
              </span>
              {t('roster.rarityValue', { count: stars })}
            </span>
          </div>
        </div>
        <button
          type="button"
          className="gta-character-expand"
          aria-expanded={expanded}
          aria-label={t(expanded ? 'roster.hideDetails' : 'roster.showDetails', {
            name: character.name
          })}
          onClick={() => setExpanded((current) => !current)}
        >
          <span aria-hidden="true">{expanded ? '−' : '+'}</span>
        </button>
      </div>

      {expanded && (
        <div className="gta-character-detail">
          <dl className="gta-character-stats">
            {statRows.map((row) => {
              const value = character.build?.stats?.[row.key];
              const label = t(row.label);
              return (
                <div className="gta-character-stat" key={row.key}>
                  <dt title={label}>
                    <StatIcon name={row.icon} />
                    <span>{label}</span>
                  </dt>
                  <dd>
                    {value ?? '—'}
                    {value !== undefined && row.suffix}
                  </dd>
                </div>
              );
            })}
          </dl>
          <div className="gta-character-build">
            <BuildLine
              icon="weapon"
              label={t('roster.weapon')}
              value={formatWeapon(character, t)}
            />
            <BuildLine
              icon="talents"
              label={t('roster.talents')}
              value={formatTalents(character)}
            />
            <BuildLine
              icon="artifacts"
              label={t('roster.artifacts')}
              value={formatArtifactSummary(character, t)}
            />
          </div>
        </div>
      )}
    </article>
  );
}

function IdentityMark({ element, name }: { element: Element; name: string }) {
  const palette = elementPalette[element];
  return (
    <div
      className="gta-character-mark"
      style={
        {
          '--character-a': palette.gradientStart,
          '--character-b': palette.bg
        } as React.CSSProperties
      }
      aria-label={name}
    >
      <span className="gta-character-mark-rune" aria-hidden="true">
        {name.trim().slice(0, 1)}
      </span>
      <span className="gta-character-mark-orbit" aria-hidden="true" />
    </div>
  );
}

function BuildLine({
  icon,
  label,
  value
}: {
  icon: 'weapon' | 'talents' | 'artifacts';
  label: string;
  value: string;
}) {
  return (
    <div className="gta-character-build-line">
      <span className="gta-character-build-label" title={label}>
        <BuildIcon name={icon} />
        {label}
      </span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function formatWeapon(character: CharacterProfile, t: ReturnType<typeof useI18n>['t']): string {
  const weapon = character.build?.weapon;
  if (!weapon) return '—';
  return `${weapon.name} · Lv ${weapon.level}${
    weapon.refinement === undefined
      ? ''
      : ` · ${t('roster.refinement', { level: weapon.refinement })}`
  }`;
}

function formatTalents(character: CharacterProfile): string {
  const talents = character.build?.talents;
  return talents
    ? `${talents.normalAttack} / ${talents.elementalSkill} / ${talents.elementalBurst}`
    : '—';
}

function formatArtifactSummary(
  character: CharacterProfile,
  t: ReturnType<typeof useI18n>['t']
): string {
  const artifacts = character.build?.artifacts;
  if (!artifacts?.length) return '—';
  const sets = new Map<string, number>();
  for (const artifact of artifacts) {
    sets.set(artifact.setName, (sets.get(artifact.setName) ?? 0) + 1);
  }
  const setSummary = [...sets.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([name, count]) => `${name}×${count}`)
    .join(' · ');
  return t('roster.artifactCount', {
    count: artifacts.length,
    sets: setSummary ? ` · ${setSummary}` : ''
  });
}
