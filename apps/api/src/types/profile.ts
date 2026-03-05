export interface CharacterStats {
  level: number;
  hp: number;
  atk: number;
  def: number;
  critRate: number;
  critDmg: number;
  energyRecharge: number;
  elementalMastery: number;
}

export interface CharacterProfile {
  id: number;
  name: string;
  element: string;
  rarity: number;
  imageUrl: string;
  stats: CharacterStats;
}

export interface CachedProfileEntry {
  uid: string;
  region?: string;
  nickname?: string;
  level?: number;
  source: 'miyoushe+enka' | 'miyoushe';
  updatedAt: string;
  profiles: CharacterProfile[];
}
