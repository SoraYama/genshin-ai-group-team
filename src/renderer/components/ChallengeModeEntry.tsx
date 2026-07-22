import type { CSSProperties } from 'react';
import abyssBackground from '../../../resources/backgrounds/spiral-abyss.webp';
import abyssBackground2x from '../../../resources/backgrounds/spiral-abyss@2x.webp';
import theaterBackground from '../../../resources/backgrounds/imaginarium-theater.webp';
import theaterBackground2x from '../../../resources/backgrounds/imaginarium-theater@2x.webp';
import stygianBackground from '../../../resources/backgrounds/stygian-onslaught.webp';
import stygianBackground2x from '../../../resources/backgrounds/stygian-onslaught@2x.webp';

export type ChallengeMode = 'spiral-abyss' | 'imaginarium-theater' | 'stygian-onslaught';

const backgrounds: Record<ChallengeMode, readonly [string, string]> = {
  'spiral-abyss': [abyssBackground, abyssBackground2x],
  'imaginarium-theater': [theaterBackground, theaterBackground2x],
  'stygian-onslaught': [stygianBackground, stygianBackground2x]
};

interface ChallengeModeEntryProps {
  mode: ChallengeMode;
  title: string;
  summary: string;
  eyebrow: string;
  selected: boolean;
  onSelect: (mode: ChallengeMode) => void;
}

export function ChallengeModeEntry({
  eyebrow,
  mode,
  onSelect,
  selected,
  summary,
  title
}: ChallengeModeEntryProps) {
  const [background, background2x] = backgrounds[mode];
  const style: CSSProperties = {
    backgroundImage: `linear-gradient(90deg, rgba(8, 17, 29, 0.94) 0%, rgba(8, 17, 29, 0.72) 52%, rgba(8, 17, 29, 0.18) 100%), image-set(url("${background}") 1x, url("${background2x}") 2x)`
  };

  return (
    <button
      type="button"
      className={selected ? 'gta-challenge-entry is-selected' : 'gta-challenge-entry'}
      style={style}
      onClick={() => onSelect(mode)}
      aria-pressed={selected}
      data-testid="challenge-mode-entry"
    >
      <span className="gta-challenge-index" aria-hidden="true">
        {eyebrow}
      </span>
      <span className="gta-challenge-copy">
        <strong>{title}</strong>
        <span>{summary}</span>
      </span>
      <span className="gta-challenge-arrow" aria-hidden="true">
        ↗
      </span>
    </button>
  );
}
