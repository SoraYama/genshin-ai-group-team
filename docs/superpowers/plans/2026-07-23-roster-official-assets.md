# Roster Official Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ambiguous element glyphs with the seven official HoYoLAB element icons, restore proxied character portraits, and remove unsupported Energy Recharge judgments from the roster.

**Architecture:** Bundle the seven official PNGs under `resources/official/genshin-elements` with an integrity manifest and renderer import map, while keeping all runtime character portraits behind the existing `gtai-img:` protocol. Keep character-card rendering decisions in small pure helpers so unit tests can prove URL allowlisting and neutral Energy Recharge presentation independently from React.

**Tech Stack:** React 19, TypeScript, Vite asset imports, Vitest, Playwright Electron E2E, CSS.

---

## File map

- `AGENTS.md`: replace the old blanket ban with the user-approved documented-official-asset policy.
- `resources/official/genshin-elements/*.png`: seven official 84×84 element icons.
- `resources/official/genshin-elements/manifest.json`: source URL and SHA-256 for each icon.
- `resources/credits.md`: ownership, source, and non-affiliation notice.
- `src/renderer/design/element-assets.ts`: typed `Element` → local asset URL map.
- `src/renderer/design/Icons.tsx`: render official PNGs through the existing `ElementIcon` API.
- `src/renderer/pages/Roster/character-presentation.ts`: validate proxied portrait URLs and normalize neutral Energy Recharge values.
- `src/renderer/pages/Roster/CharacterCard.tsx`: render the runtime portrait with fallback and neutral Energy Recharge copy.
- `src/renderer/styles/pages/roster.css`: portrait image sizing and fallback-only decoration.
- `src/renderer/i18n/index.tsx`: Chinese and English neutral Energy Recharge text.
- `tests/unit/gates/release-quality.spec.ts`: verify icon manifest, hashes, credits, and updated asset policy.
- `tests/unit/renderer/element-assets.spec.tsx`: verify all elements render local official PNG assets.
- `tests/unit/renderer/character-presentation.spec.ts`: replace threshold tests with URL and neutral-value tests.
- `tests/unit/renderer/character-card.spec.tsx`: verify portrait image and fallback markup.
- `tests/e2e/app.spec.ts`: assert the roster shows proxied portraits and no unsupported Energy Recharge labels.
- `tests/e2e/visual-signatures.json`: update only roster signatures changed by the approved UI correction.

### Task 1: Change the asset policy and add integrity-checked official icons

**Files:**
- Modify: `AGENTS.md:305-314`
- Create: `resources/official/genshin-elements/manifest.json`
- Create: `resources/official/genshin-elements/{pyro,hydro,electro,anemo,geo,cryo,dendro}.png`
- Modify: `resources/credits.md`
- Modify: `tests/unit/gates/release-quality.spec.ts`

- [ ] **Step 1: Write the failing release gate**

Replace the obsolete assertions with a manifest integrity test:

```ts
it('accounts for every bundled official element icon by source and sha256', async () => {
  const directory = path.join(RESOURCES_ROOT, 'official/genshin-elements');
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as {
    owner: string;
    sourcePage: string;
    icons: Record<string, { file: string; source: string; sha256: string }>;
  };
  expect(manifest.owner).toBe('COGNOSPHERE / HoYoverse');
  expect(Object.keys(manifest.icons).sort()).toEqual(
    ['anemo', 'cryo', 'dendro', 'electro', 'geo', 'hydro', 'pyro']
  );
  for (const icon of Object.values(manifest.icons)) {
    const data = await readFile(path.join(directory, icon.file));
    expect(data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(createHash('sha256').update(data).digest('hex')).toBe(icon.sha256);
    expect(icon.source).toMatch(/^https:\/\/wiki\.hoyolab\.com\//u);
  }
  const credits = await readFile(path.join(RESOURCES_ROOT, 'credits.md'), 'utf8');
  expect(credits).toContain('HoYoLAB official Wiki element icons');
  expect(credits).toContain(manifest.sourcePage);
});
```

- [ ] **Step 2: Run the gate and verify it fails**

Run: `npx vitest run tests/unit/gates/release-quality.spec.ts`

Expected: FAIL because `resources/official/genshin-elements/manifest.json` does not exist.

- [ ] **Step 3: Copy the seven verified downloads and add the manifest**

Copy the files previously downloaded from HoYoLAB into the resource directory and write:

```json
{
  "owner": "COGNOSPHERE / HoYoverse",
  "sourcePage": "https://wiki.hoyolab.com/pc/genshin/entry/50",
  "icons": {
    "pyro": { "file": "pyro.png", "source": "https://wiki.hoyolab.com/_nuxt/img/pyro.2267e27.png", "sha256": "381de2f24f84865ceb1001bef09a590f1ed92a74fb054f02499a1d26cfe9df39" },
    "hydro": { "file": "hydro.png", "source": "https://wiki.hoyolab.com/_nuxt/img/hydro.3e969aa.png", "sha256": "7790182c6c6683c45ecc026f3c4ed05f2e535c2d260efbe4682f08d4f9fdb3a9" },
    "electro": { "file": "electro.png", "source": "https://wiki.hoyolab.com/_nuxt/img/electro.be07020.png", "sha256": "17f7efe2e899df878763961a0b17850268e1c12b9378f9cee0f0d71a1c81df66" },
    "anemo": { "file": "anemo.png", "source": "https://wiki.hoyolab.com/_nuxt/img/anemo.e0f1804.png", "sha256": "af5b7f18c56adb555b426dce1f7ef47bf24af0b7d78e6f73901bc2a634d9c62d" },
    "geo": { "file": "geo.png", "source": "https://wiki.hoyolab.com/_nuxt/img/geo.2498e06.png", "sha256": "4efda75c00754aa61286c482322fbed7e6ae10f930e3bc2be6068d2dc0af8356" },
    "cryo": { "file": "cryo.png", "source": "https://wiki.hoyolab.com/_nuxt/img/cryo.b810caa.png", "sha256": "b78cb2181e50ea0cd070cef85bc3077aab16281d8fa142616b276e0a6ce9d4ea" },
    "dendro": { "file": "dendro.png", "source": "https://wiki.hoyolab.com/_nuxt/img/dendro.88f5bfa.png", "sha256": "2fdd18af92c02e680c9b885bb0c2f0ec57d300da56e8353eae72b96ad64ea9c2" }
  }
}
```

Update `AGENTS.md` to allow documented official public visual assets approved for the product, and update `resources/credits.md` with exact source ownership and non-affiliation language.

- [ ] **Step 4: Run the release gate**

Run: `npx vitest run tests/unit/gates/release-quality.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md resources/official/genshin-elements resources/credits.md tests/unit/gates/release-quality.spec.ts
git commit -m "feat: add credited official element icons"
```

### Task 2: Render official icons through the existing component API

**Files:**
- Create: `src/renderer/design/element-assets.ts`
- Modify: `src/renderer/design/Icons.tsx:26-77`
- Create: `tests/unit/renderer/element-assets.spec.tsx`

- [ ] **Step 1: Write the failing renderer test**

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ElementIcon } from '../../../src/renderer/design/Icons.js';
import { elements } from '../../../src/renderer/design/tokens.js';

describe('official element assets', () => {
  it.each(elements)('renders the bundled %s icon as a local PNG', (element) => {
    const markup = renderToStaticMarkup(<ElementIcon element={element} size={24} />);
    expect(markup).toContain('<img');
    expect(markup).toContain(`${element}.png`);
    expect(markup).toContain('width="24"');
    expect(markup).toContain('height="24"');
    expect(markup).not.toContain('<svg');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/unit/renderer/element-assets.spec.tsx`

Expected: FAIL because `ElementIcon` still renders the custom SVG paths.

- [ ] **Step 3: Add the typed asset map and PNG implementation**

Create `element-assets.ts` with seven explicit imports and a `satisfies Record<Element, string>` map. Replace the SVG gradient and `ElementShape` switch with:

```tsx
export function ElementIcon({ element, className, size = 18 }: ElementIconProps) {
  return (
    <img
      className={className}
      src={elementIconAssets[element]}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
```

- [ ] **Step 4: Run the renderer and release tests**

Run: `npx vitest run tests/unit/renderer/element-assets.spec.tsx tests/unit/gates/release-quality.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/design/element-assets.ts src/renderer/design/Icons.tsx tests/unit/renderer/element-assets.spec.tsx
git commit -m "feat: render official element assets"
```

### Task 3: Restore the proxied character portrait with a safe fallback

**Files:**
- Modify: `src/renderer/pages/Roster/character-presentation.ts`
- Modify: `src/renderer/pages/Roster/CharacterCard.tsx`
- Modify: `src/renderer/styles/pages/roster.css`
- Modify: `tests/unit/renderer/character-presentation.spec.ts`
- Create: `tests/unit/renderer/character-card.spec.tsx`

- [ ] **Step 1: Add failing URL policy tests**

```ts
it('accepts only the existing main-process image proxy for portraits', () => {
  expect(isRenderableCharacterPortrait('gtai-img://avatar/UI_AvatarIcon_Kazuha.png')).toBe(true);
  expect(isRenderableCharacterPortrait('gtai-img://remote/abc123')).toBe(true);
  expect(isRenderableCharacterPortrait('https://enka.network/ui/a.png')).toBe(false);
  expect(isRenderableCharacterPortrait('file:///tmp/a.png')).toBe(false);
  expect(isRenderableCharacterPortrait('')).toBe(false);
});
```

Add a server-render test that expects a legal URL to emit `<img loading="lazy" decoding="async">` and an empty URL to emit the fallback mark.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npx vitest run tests/unit/renderer/character-presentation.spec.ts tests/unit/renderer/character-card.spec.tsx`

Expected: FAIL because the URL helper and `CharacterPortrait` do not exist.

- [ ] **Step 3: Implement the URL helper and portrait component**

Add:

```ts
export function isRenderableCharacterPortrait(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'gtai-img:' && (url.host === 'avatar' || url.host === 'remote');
  } catch {
    return false;
  }
}
```

Replace the unconditional `IdentityMark` call with an exported `CharacterPortrait` that keeps `failedUrl` state, uses the proxy URL while valid and not failed, and falls back to `IdentityMark` from its `onError` handler. Add `.has-image img { width: 100%; height: 100%; object-fit: cover; object-position: center top; }` and suppress rune-only decoration for `.has-image`.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/unit/renderer/character-presentation.spec.ts tests/unit/renderer/character-card.spec.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/pages/Roster/character-presentation.ts src/renderer/pages/Roster/CharacterCard.tsx src/renderer/styles/pages/roster.css tests/unit/renderer/character-presentation.spec.ts tests/unit/renderer/character-card.spec.tsx
git commit -m "fix: restore proxied roster portraits"
```

### Task 4: Remove unsupported Energy Recharge judgments

**Files:**
- Modify: `src/renderer/pages/Roster/character-presentation.ts`
- Modify: `src/renderer/pages/Roster/CharacterCard.tsx`
- Modify: `src/renderer/i18n/index.tsx`
- Modify: `tests/unit/renderer/character-presentation.spec.ts`

- [ ] **Step 1: Replace the threshold test with neutral presentation tests**

```ts
it('presents Energy Recharge only as known or unknown panel data', () => {
  expect(presentEnergyRecharge(undefined)).toEqual({ kind: 'unknown' });
  expect(presentEnergyRecharge(Number.NaN)).toEqual({ kind: 'unknown' });
  expect(presentEnergyRecharge(0)).toEqual({ kind: 'unknown' });
  expect(presentEnergyRecharge(117.5)).toEqual({ kind: 'known', value: 117.5 });
  expect(presentEnergyRecharge(240)).toEqual({ kind: 'known', value: 240 });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run tests/unit/renderer/character-presentation.spec.ts`

Expected: FAIL because `presentEnergyRecharge` is not implemented and old threshold exports still exist.

- [ ] **Step 3: Implement neutral presentation and copy**

Delete `ENERGY_RECHARGE_THRESHOLDS`, `EnergyRechargeBand`, and `classifyEnergyRecharge`. Add:

```ts
export type PresentedEnergyRecharge =
  | { kind: 'known'; value: number }
  | { kind: 'unknown' };

export function presentEnergyRecharge(value: number | undefined): PresentedEnergyRecharge {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? { kind: 'known', value }
    : { kind: 'unknown' };
}
```

Render `roster.energyRecharge` as the fact label. Use `roster.energyPanel.known` for the neutral contextual sentence and `roster.energyPanel.unknown` for missing data in both languages. Remove every `roster.energyHint.*` key.

- [ ] **Step 4: Run renderer tests and scan for obsolete language**

Run: `npx vitest run tests/unit/renderer/character-presentation.spec.ts`

Run: `rg -n "classifyEnergyRecharge|ENERGY_RECHARGE_THRESHOLDS|面板充能偏低|Panel Energy Recharge is low" src tests`

Expected: test PASS and ripgrep returns no matches.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/pages/Roster/character-presentation.ts src/renderer/pages/Roster/CharacterCard.tsx src/renderer/i18n/index.tsx tests/unit/renderer/character-presentation.spec.ts
git commit -m "fix: make roster energy copy evidence-neutral"
```

### Task 5: Verify the Electron roster and update only approved visual baselines

**Files:**
- Modify: `tests/e2e/app.spec.ts`
- Modify: `tests/e2e/visual-signatures.json`

- [ ] **Step 1: Add E2E assertions**

In the roster flow, assert:

```ts
await expect(page.locator('.gta-character-mark.has-image img').first()).toBeVisible();
await expect(page.getByText(/面板充能偏低|面板充能中等|面板充能较高/u)).toHaveCount(0);
await expect(page.getByText('充能效率', { exact: true }).first()).toBeVisible();
```

- [ ] **Step 2: Run the focused Electron E2E**

Run: `npm run build && npx playwright test tests/e2e/app.spec.ts`

Expected: PASS with no renderer errors or external Renderer requests.

- [ ] **Step 3: Capture and inspect the visual matrix**

Run: `npm run test:e2e:visual:record`

Expected: printed `VISUAL_SIGNATURE` lines and screenshots under `test-results/visual-matrix`. Inspect the four `roster-expanded-detail-*` PNGs; update only those four hashes in `tests/e2e/visual-signatures.json`.

- [ ] **Step 4: Run complete verification**

Run: `npm run gate:local`

Run: `npm run test:e2e:visual`

Expected: both commands PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/app.spec.ts tests/e2e/visual-signatures.json
git commit -m "test: verify corrected roster visuals"
```

