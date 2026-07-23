import { useState, type CSSProperties } from 'react';
import type {
  ArtifactPiece,
  CharacterProfile,
  CharacterStats,
  FieldProvenance
} from '../../../shared/domain';
import { BuildIcon, ElementIcon, StarIcon, StatIcon, type StatIconName } from '../../design/Icons';
import { elementPalette, normalizeElement, type Element } from '../../design/tokens';
import { useI18n, type TranslationKey } from '../../i18n';
import {
  artifactStatUsesPercent,
  isRenderableCharacterPortrait,
  presentArtifactStatKey,
  presentEnergyRecharge,
  reactionTagsForElement
} from './character-presentation';

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
  const { locale, t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const element = normalizeElement(character.element);
  const rarity = normalizeRarity(character.rarity);
  const reactions = reactionTagsForElement(element);
  const energyRecharge = presentEnergyRecharge(character.build?.stats?.energyRecharge);
  const completenessLabel = {
    basic: t('roster.basic'),
    build: t('roster.build'),
    detailed: t('roster.detailed')
  }[character.completeness];

  return (
    <article
      className={`gta-character ${rarity ? `r${rarity}` : 'r-unknown'}`}
      data-element={element ?? 'unknown'}
      style={
        {
          '--character-element': element ? elementPalette[element].flat : '#71808a'
        } as CSSProperties
      }
    >
      <div className="gta-character-main">
        <CharacterPortrait
          name={character.name}
          element={element}
          imageUrl={character.imageUrl}
        />
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
              {element ? (
                <ElementIcon element={element} size={16} />
              ) : (
                <span className="gta-neutral-element" aria-hidden="true">
                  ◇
                </span>
              )}
              {element ? t(`roster.element.${element}`) : t('roster.element.unknown')}
            </span>
            <span title={t('roster.rarity')}>
              {rarity ? (
                <>
                  <span className="gta-character-stars" aria-hidden="true">
                    {Array.from({ length: rarity }, (_, index) => (
                      <StarIcon key={index} />
                    ))}
                  </span>
                  {t('roster.rarityValue', { count: rarity })}
                </>
              ) : (
                t('roster.rarityUnknown')
              )}
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

      <div className="gta-character-team-layer">
        <TeamFact label={t('roster.roleLabel')} value={t('roster.rolePending')} />
        <TeamFact label={t('roster.currentWeapon')} value={formatWeapon(character, t)} />
        {reactions.length > 0 && (
          <div className="gta-character-team-fact gta-character-reactions">
            <span>{t('roster.availableReactions')}</span>
            <div>
              {reactions.map((reaction) => (
                <em key={reaction}>{t(`roster.reaction.${reaction}`)}</em>
              ))}
            </div>
          </div>
        )}
        <TeamFact
          label={t('roster.energyRecharge')}
          value={
            energyRecharge.kind === 'known'
              ? t('roster.energyPanel.known', { value: energyRecharge.value })
              : t('roster.energyPanel.unknown')
          }
        />
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
          <ArtifactDetails artifacts={character.build?.artifacts} />
          <ProvenanceDetails character={character} locale={locale} />
        </div>
      )}
    </article>
  );
}

function TeamFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="gta-character-team-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function CharacterPortrait({
  element,
  imageUrl,
  name
}: {
  element: Element | undefined;
  imageUrl: string | undefined;
  name: string;
}) {
  const [failedImageUrl, setFailedImageUrl] = useState<string>();
  const canShowImage =
    isRenderableCharacterPortrait(imageUrl) && failedImageUrl !== imageUrl;

  if (!canShowImage) {
    return <IdentityMark name={name} element={element} />;
  }

  return (
    <div className="gta-character-mark has-image">
      <img
        src={imageUrl}
        alt={name}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailedImageUrl(imageUrl)}
      />
    </div>
  );
}

function IdentityMark({ element, name }: { element: Element | undefined; name: string }) {
  const palette = element ? elementPalette[element] : undefined;
  return (
    <div
      className={element ? 'gta-character-mark' : 'gta-character-mark is-unknown'}
      style={
        {
          '--character-a': palette?.gradientStart ?? '#71808a',
          '--character-b': palette?.bg ?? '#3f505c'
        } as CSSProperties
      }
      aria-label={name}
    >
      <span className="gta-character-mark-rune" aria-hidden="true">
        {name.trim().slice(0, 1) || '◇'}
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

function ArtifactDetails({ artifacts }: { artifacts: ArtifactPiece[] | undefined }) {
  const { t } = useI18n();
  if (!artifacts?.length) return null;
  return (
    <section className="gta-character-artifact-detail" aria-label={t('roster.artifactDetails')}>
      <h4>{t('roster.artifactDetails')}</h4>
      <ul>
        {artifacts.map((artifact, index) => {
          const presented = presentArtifactStatKey(artifact.mainStat.key);
          const statLabel =
            presented.kind === 'known'
              ? t(`roster.artifactStat.${presented.key}`)
              : presented.label;
          const suffix = artifactStatUsesPercent(presented) ? '%' : '';
          return (
            <li key={`${artifact.slot}-${artifact.setId}-${index}`}>
              <strong>{t(`roster.artifactSlot.${artifact.slot}`)}</strong>
              <span>
                {statLabel} {artifact.mainStat.value}
                {suffix}
              </span>
              <small>
                {artifact.setName || t('roster.unknownSet')} · +{artifact.level}
              </small>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ProvenanceDetails({ character, locale }: { character: CharacterProfile; locale: string }) {
  const { t } = useI18n();
  const rows: Array<{ label: TranslationKey; provenance: FieldProvenance | undefined }> = [
    { label: 'roster.provenance.ownership', provenance: character.provenance.ownership },
    { label: 'roster.provenance.build', provenance: character.provenance.build },
    { label: 'roster.provenance.stats', provenance: character.provenance.stats }
  ];
  return (
    <section className="gta-character-provenance" aria-label={t('roster.provenance.title')}>
      <h4>{t('roster.provenance.title')}</h4>
      <ul>
        {rows.map((row) => (
          <li key={row.label}>
            <strong>{t(row.label)}</strong>
            {row.provenance ? (
              <span>
                {provenanceSourceLabel(row.provenance, t)} ·{' '}
                {t('roster.provenance.updatedAt', {
                  date: formatTimestamp(row.provenance.fetchedAt, locale)
                })}
                {row.provenance.stale ? ` · ${t('roster.provenance.stale')}` : ''}
              </span>
            ) : (
              <span>{t('roster.provenance.unavailable')}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function provenanceSourceLabel(
  provenance: FieldProvenance,
  t: ReturnType<typeof useI18n>['t']
): string {
  if (provenance.source === 'enka') return t('roster.provenance.showcase');
  if (provenance.source === 'miyoushe-detail') return t('roster.provenance.miyousheBuild');
  return t('roster.provenance.miyousheRoster');
}

function formatTimestamp(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(iso));
}

function normalizeRarity(rarity: number): number | undefined {
  return Number.isInteger(rarity) && rarity >= 1 && rarity <= 5 ? rarity : undefined;
}

function formatWeapon(character: CharacterProfile, t: ReturnType<typeof useI18n>['t']): string {
  const weapon = character.build?.weapon;
  if (!weapon) return t('roster.weaponUnknown');
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
    .map(([name, count]) => `${name || t('roster.unknownSet')}×${count}`)
    .join(' · ');
  return t('roster.artifactCount', {
    count: artifacts.length,
    sets: setSummary ? ` · ${setSummary}` : ''
  });
}
