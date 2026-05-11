import Store from 'electron-store';
import type {
  PersistedProfile,
  ProfileListItem,
  ProfileStateView
} from '../../shared/domain.js';
import { rewriteEnkaToProxyUrl } from './icon-proxy.js';

interface ProfileStoreSchema {
  activeUid?: string;
  profilesByUid: Record<string, PersistedProfile>;
}

const DEFAULTS: ProfileStoreSchema = {
  profilesByUid: {}
};

function toListItem(profile: PersistedProfile): ProfileListItem {
  return {
    uid: profile.uid,
    nickname: profile.nickname,
    level: profile.level,
    source: profile.source,
    fetchedAt: profile.fetchedAt,
    characterCount: profile.characters.length
  };
}

export class ProfileStore {
  private readonly store: Store<ProfileStoreSchema>;

  constructor() {
    this.store = new Store<ProfileStoreSchema>({
      name: 'profiles',
      defaults: DEFAULTS
    });
    this.migrateIconUrls();
  }

  private migrateIconUrls(): void {
    const all = this.store.get('profilesByUid');
    let dirty = false;

    for (const uid of Object.keys(all)) {
      const profile = all[uid];
      if (!profile) {
        continue;
      }
      let profileChanged = false;
      const migratedCharacters = profile.characters.map((character) => {
        const next = rewriteEnkaToProxyUrl(character.imageUrl);
        if (next === character.imageUrl) {
          return character;
        }
        profileChanged = true;
        return { ...character, imageUrl: next };
      });

      if (profileChanged) {
        all[uid] = { ...profile, characters: migratedCharacters };
        dirty = true;
      }
    }

    if (dirty) {
      this.store.set('profilesByUid', all);
    }
  }

  upsert(profile: PersistedProfile): void {
    const all = this.getAll();
    all[profile.uid] = profile;
    this.store.set('profilesByUid', all);

    if (!this.store.get('activeUid')) {
      this.store.set('activeUid', profile.uid);
    }
  }

  get(uid: string): PersistedProfile | undefined {
    return this.getAll()[uid];
  }

  remove(uid: string): boolean {
    const all = this.getAll();
    if (!(uid in all)) {
      return false;
    }

    delete all[uid];
    this.store.set('profilesByUid', all);

    if (this.store.get('activeUid') === uid) {
      const remaining = Object.keys(all);
      if (remaining.length === 0) {
        this.store.delete('activeUid');
      } else {
        this.store.set('activeUid', remaining[0]);
      }
    }
    return true;
  }

  setActive(uid: string): void {
    if (!(uid in this.getAll())) {
      throw new Error(`Profile not found: ${uid}`);
    }
    this.store.set('activeUid', uid);
  }

  getActiveUid(): string | undefined {
    return this.store.get('activeUid');
  }

  getStateView(): ProfileStateView {
    const all = this.getAll();
    const profiles = Object.values(all)
      .map(toListItem)
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));

    return {
      activeUid: this.store.get('activeUid'),
      profiles
    };
  }

  private getAll(): Record<string, PersistedProfile> {
    return { ...this.store.get('profilesByUid') };
  }
}
