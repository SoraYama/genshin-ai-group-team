import type { AppConfig } from '../config.js';

interface AvatarMetadata {
  id: number;
  name: string;
  icon: string;
  element: string;
  rarity: number;
}

interface CharacterRaw {
  NameTextMapHash?: number;
  SideIconName?: string;
  Element?: string;
  QualityType?: string;
}

interface MetadataCache {
  loadedAt: number;
  byId: Map<number, AvatarMetadata>;
}

let metadataCache: MetadataCache | undefined;

const CACHE_TTL_MS = 60 * 60 * 1000;

function iconFromSideIcon(sideIconName?: string): string {
  if (!sideIconName) {
    return 'UI_AvatarIcon_PlayerBoy';
  }

  if (sideIconName.startsWith('UI_AvatarIcon_Side_')) {
    return sideIconName.replace('UI_AvatarIcon_Side_', 'UI_AvatarIcon_');
  }

  return sideIconName;
}

function rarityFromQuality(qualityType?: string): number {
  if (!qualityType) {
    return 4;
  }

  if (qualityType.includes('ORANGE')) {
    return 5;
  }

  if (qualityType.includes('PURPLE')) {
    return 4;
  }

  return 4;
}

function selectLocaleMap(loc: Record<string, Record<string, string>>): Record<string, string> {
  const keys = ['chs', 'zh-cn', 'zh', 'en'];
  for (const key of keys) {
    const value = loc[key];
    if (value) {
      return value;
    }
  }

  const first = Object.values(loc)[0];
  return first ?? {};
}

export async function getAvatarMetadata(options: {
  config: AppConfig;
  fetchImpl?: typeof fetch;
}): Promise<Map<number, AvatarMetadata>> {
  if (metadataCache && Date.now() - metadataCache.loadedAt < CACHE_TTL_MS) {
    return metadataCache.byId;
  }

  const fetchImpl = options.fetchImpl ?? fetch;

  const [charactersRaw, locRaw] = await Promise.all([
    fetchImpl(options.config.enkaCharactersMetaUrl),
    fetchImpl(options.config.enkaLocMetaUrl)
  ]);

  const charactersJson = (await charactersRaw.json()) as Record<string, CharacterRaw>;
  const locJson = (await locRaw.json()) as Record<string, Record<string, string>>;

  const localeMap = selectLocaleMap(locJson);
  const byId = new Map<number, AvatarMetadata>();

  for (const [avatarId, raw] of Object.entries(charactersJson)) {
    const id = Number(avatarId);
    if (!Number.isFinite(id)) {
      continue;
    }

    const textHash = raw.NameTextMapHash ? String(raw.NameTextMapHash) : '';
    const name = localeMap[textHash] ?? `角色-${id}`;
    const iconName = iconFromSideIcon(raw.SideIconName);

    byId.set(id, {
      id,
      name,
      icon: `https://enka.network/ui/${iconName}.png`,
      element: raw.Element ?? 'Unknown',
      rarity: rarityFromQuality(raw.QualityType)
    });
  }

  metadataCache = {
    loadedAt: Date.now(),
    byId
  };

  return byId;
}
