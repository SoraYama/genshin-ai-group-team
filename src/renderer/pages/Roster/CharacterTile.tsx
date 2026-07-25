import { useState, type CSSProperties } from 'react';
import type { CharacterProfile } from '../../../shared/domain';
import { ElementIcon } from '../../design/Icons';
import { elementPalette, normalizeElement, type Element } from '../../design/tokens';
import { useI18n } from '../../i18n';
import { isRenderableCharacterPortrait, renderTile } from './character-presentation';

interface CharacterTileProps {
  character: CharacterProfile;
  selected: boolean;
  onSelect: (trigger: HTMLButtonElement) => void;
}

export function CharacterTile({ character, onSelect, selected }: CharacterTileProps) {
  const { t } = useI18n();
  const tile = renderTile(character);
  const element = normalizeElement(tile.element);
  const completenessLabel = {
    basic: t('roster.basic'),
    build: t('roster.build'),
    detailed: t('roster.detailed')
  }[tile.completeness];

  return (
    <button
      type="button"
      className="character-tile"
      data-testid="character-tile"
      data-element={element ?? 'unknown'}
      aria-controls={selected ? 'character-detail-drawer' : undefined}
      aria-label={t('roster.viewDetails', { name: tile.name })}
      aria-pressed={selected}
      style={
        {
          '--character-element': element ? elementPalette[element].flat : '#71808a'
        } as CSSProperties
      }
      onClick={(event) => onSelect(event.currentTarget)}
    >
      <CharacterPortrait element={element} imageUrl={character.imageUrl} name={tile.name} />
      <span className="character-tile__copy">
        <strong>{tile.name}</strong>
        <span className="character-tile__meta">
          <span>{t('roster.levelShort', { level: tile.level })}</span>
          <span title={t('roster.element')}>
            {element ? (
              <ElementIcon element={element} size={15} />
            ) : (
              <span className="gta-neutral-element" aria-hidden="true">
                ◇
              </span>
            )}
          </span>
        </span>
      </span>
      <span className={`character-tile__completeness is-${tile.completeness}`}>
        {completenessLabel}
      </span>
    </button>
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
  const canShowImage = isRenderableCharacterPortrait(imageUrl) && failedImageUrl !== imageUrl;

  if (!canShowImage) {
    return <IdentityMark name={name} element={element} />;
  }

  return (
    <span className="character-tile__portrait has-image">
      <img
        src={imageUrl}
        alt={name}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailedImageUrl(imageUrl)}
      />
    </span>
  );
}

function IdentityMark({ element, name }: { element: Element | undefined; name: string }) {
  const palette = element ? elementPalette[element] : undefined;
  return (
    <span
      className={element ? 'character-tile__portrait' : 'character-tile__portrait is-unknown'}
      style={
        {
          '--character-a': palette?.gradientStart ?? '#71808a',
          '--character-b': palette?.bg ?? '#3f505c'
        } as CSSProperties
      }
      aria-hidden="true"
    >
      <span className="character-tile__rune">{name.trim().slice(0, 1) || '◇'}</span>
      <span className="character-tile__orbit" />
    </span>
  );
}
