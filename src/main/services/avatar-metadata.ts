import { request } from 'undici';
import { buildIconUrl } from './icon-proxy.js';

export interface AvatarMetadata {
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

interface MetadataSnapshot {
  loadedAt: number;
  byId: Map<number, AvatarMetadata>;
}

const DEFAULT_CHARACTERS_URL =
  'https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store/characters.json';
const DEFAULT_LOC_URL =
  'https://raw.githubusercontent.com/EnkaNetwork/API-docs/master/store/loc.json';
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 12_000;

function iconFromSideIcon(sideIconName?: string): string {
  if (!sideIconName) {
    return 'UI_AvatarIcon_PlayerBoy';
  }
  if (sideIconName.startsWith('UI_AvatarIcon_Side_')) {
    return sideIconName.replace('UI_AvatarIcon_Side_', 'UI_AvatarIcon_');
  }
  return sideIconName;
}

function rarityFromQuality(quality?: string): number {
  if (!quality) {
    return 4;
  }
  if (quality.includes('ORANGE')) {
    return 5;
  }
  return 4;
}

function pickLocaleMap(loc: Record<string, Record<string, string>>): Record<string, string> {
  const candidates = ['chs', 'zh-cn', 'zh', 'en'];
  for (const key of candidates) {
    const map = loc[key];
    if (map) {
      return map;
    }
  }
  const first = Object.values(loc)[0];
  return first ?? {};
}

export interface AvatarMetadataServiceOptions {
  charactersUrl?: string;
  locUrl?: string;
  ttlMs?: number;
  timeoutMs?: number;
}

export class AvatarMetadataService {
  private snapshot: MetadataSnapshot | undefined;
  private readonly charactersUrl: string;
  private readonly locUrl: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private inflight: Promise<Map<number, AvatarMetadata>> | undefined;

  constructor(options: AvatarMetadataServiceOptions = {}) {
    this.charactersUrl = options.charactersUrl ?? DEFAULT_CHARACTERS_URL;
    this.locUrl = options.locUrl ?? DEFAULT_LOC_URL;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async load(): Promise<Map<number, AvatarMetadata>> {
    if (this.snapshot && Date.now() - this.snapshot.loadedAt < this.ttlMs) {
      return this.snapshot.byId;
    }

    if (this.inflight) {
      return this.inflight;
    }

    this.inflight = this.fetchAndCache().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchAndCache(): Promise<Map<number, AvatarMetadata>> {
    const [characters, loc] = await Promise.all([
      this.fetchJson<Record<string, CharacterRaw>>(this.charactersUrl),
      this.fetchJson<Record<string, Record<string, string>>>(this.locUrl)
    ]);

    const localeMap = pickLocaleMap(loc);
    const byId = new Map<number, AvatarMetadata>();

    for (const [rawId, raw] of Object.entries(characters)) {
      const id = Number(rawId);
      if (!Number.isFinite(id)) {
        continue;
      }
      const nameHash = raw.NameTextMapHash ? String(raw.NameTextMapHash) : '';
      const name = localeMap[nameHash] ?? `角色-${id}`;
      const iconName = iconFromSideIcon(raw.SideIconName);
      byId.set(id, {
        id,
        name,
        icon: buildIconUrl(`${iconName}.png`),
        element: raw.Element ?? 'Unknown',
        rarity: rarityFromQuality(raw.QualityType)
      });
    }

    this.snapshot = { loadedAt: Date.now(), byId };
    return byId;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const { statusCode, body } = await request(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      bodyTimeout: this.timeoutMs,
      headersTimeout: this.timeoutMs
    });
    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`Failed to load avatar metadata: HTTP ${statusCode} ${url}`);
    }
    return (await body.json()) as T;
  }
}
