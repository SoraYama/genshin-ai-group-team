import anemo from '../../../resources/official/genshin-elements/anemo.png';
import cryo from '../../../resources/official/genshin-elements/cryo.png';
import dendro from '../../../resources/official/genshin-elements/dendro.png';
import electro from '../../../resources/official/genshin-elements/electro.png';
import geo from '../../../resources/official/genshin-elements/geo.png';
import hydro from '../../../resources/official/genshin-elements/hydro.png';
import pyro from '../../../resources/official/genshin-elements/pyro.png';
import type { Element } from './tokens';

export const elementIconAssets = {
  pyro,
  hydro,
  electro,
  anemo,
  geo,
  cryo,
  dendro
} satisfies Record<Element, string>;
