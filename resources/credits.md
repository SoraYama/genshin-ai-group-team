# Credits and notices

genshin-team-advisor bundles a limited set of official Genshin Impact element icons so players can recognize game terminology immediately. It does not bundle game audio or proprietary game fonts.

Bundled visual dependencies:

- Noto Sans SC — SIL Open Font License 1.1, distributed through `@fontsource/noto-sans-sc`.
- JetBrains Mono — SIL Open Font License 1.1, distributed through `@fontsource/jetbrains-mono`.
- All application SVG/CSS decorations and non-element icons in this repository are original project assets unless a file states otherwise.
- HoYoLAB official Wiki element icons — Pyro, Hydro, Electro, Anemo, Geo, Cryo, and Dendro PNGs loaded by the official character pages, downloaded from `https://wiki.hoyolab.com/pc/genshin/entry/50` and equivalent official character entries on 2026-07-23. Exact CDN URLs and SHA-256 digests are recorded in `resources/official/genshin-elements/manifest.json`. Copyright and related rights belong to COGNOSPHERE / HoYoverse.
- `resources/backgrounds/app-global*.webp` — original image generated with OpenAI image generation on 2026-07-22 for the global application atmosphere. Prompt direction: an original quiet high-fantasy night landscape with cool blue-gray mist, ivory light and restrained gold; no characters, official locations, UI, text, or logos. Converted to WebP at 1600×1000 and 2560×1600.
- `resources/backgrounds/spiral-abyss*.webp` — original image generated with OpenAI image generation on 2026-07-22 for the two-team challenge entry. Prompt direction: an abstract vertical star observatory and paired paths; no characters, official locations, UI, text, or logos. Converted to WebP at 1600×1000 and 2560×1600.
- `resources/backgrounds/imaginarium-theater*.webp` — original image generated with OpenAI image generation on 2026-07-22 for the cast-and-route challenge entry. Prompt direction: an original moonlit fantasy stage and branching lantern path; no characters, official locations, UI, text, or logos. Converted to WebP at 1600×1000 and 2560×1600.
- `resources/backgrounds/stygian-onslaught*.webp` — original image generated with OpenAI image generation on 2026-07-22 for the three-phase boss challenge entry. Prompt direction: an original storm-lit arena with three distant monolith silhouettes; no characters, official locations, UI, text, or logos. Converted to WebP at 1600×1000 and 2560×1600.

## Reviewed advisor knowledge

The versioned files under `resources/knowledge/` are developer-reviewed source assets. Runtime web search results are never written back into these trusted bundles. Strategy facts are concise Chinese **paraphrased summaries, not copied guide text**. Links identify the pages reviewed and do not imply endorsement by their authors.

Catalog provenance, retrieved 2026-07-24:

- EnkaNetwork API Docs revision `2b9d23b334306f5845551ae7571d1165cdf096e5`, `store/characters.json` — `https://raw.githubusercontent.com/EnkaNetwork/API-docs/2b9d23b334306f5845551ae7571d1165cdf096e5/store/characters.json`; used for upstream canonical IDs, element and weapon metadata; SHA-256 `51dbaef256968a41dab3429d60f88f77f29645c4b79bf606fc93d4fbf3be33e4`.
- EnkaNetwork API Docs revision `2b9d23b334306f5845551ae7571d1165cdf096e5`, `store/loc.json` — `https://raw.githubusercontent.com/EnkaNetwork/API-docs/2b9d23b334306f5845551ae7571d1165cdf096e5/store/loc.json`; used for Simplified Chinese names; SHA-256 `ee8a58105be0595b386d035377711d7aa0859d09550241b291459372bbd38976`.
- The snapshot exposes 114 populated numeric rows, but five are not canonical player-roster characters: trial IDs `10000901` and `10000902`, alternate ID `10000903` (mapped to canonical `10000116`), provisional ID `10000904`, and test ID `11000046`. They are recorded in the catalog's bounded `exclusions` audit list, leaving 109 canonical entries. This is a documented upstream discrepancy from the original 112-character acceptance floor.

Reproducible review evidence:

- `resources/knowledge/review-evidence.v1.json` contains only short upstream section labels and this project's own Chinese paraphrased review conclusions, with each fact ID bound to the SHA-256 of its committed fact statement. Each reviewed archetype is also bound to the SHA-256 of its complete canonical policy object, including roles, environments, teammate requirements, signals, thresholds, facts, and explicit unknowns. It does not copy guide paragraphs.
- Citation `reviewEvidenceSha256` is the SHA-256 of one committed evidence entry serialized as UTF-8 canonical JSON: object keys are recursively sorted lexicographically, array order is preserved, and no insignificant whitespace is emitted.
- `sourceRegistrySha256` in both the evidence and mechanic bundles is the SHA-256 of the complete canonical `sources.v1.json` object under the same serialization. It binds source IDs, names, hosts, trust, review cadence, and every citation identity, timestamp, subject, evidence version, and evidence digest across the loaded files. Current digest: `dcee0ba3eb2661cd0155e8962884c4058f61e8f60b6f26ba7405b6b897e9346a`.
- These digests make the bundled reviewed snapshot locally tamper-evident across the files loaded together; they are not an external signature or independent trust root. They cover the committed evidence and archetype policy, **not upstream page HTML** or future upstream changes.
- Raiden Shogun review evidence — `887fb33f2722d1a513e3d1d0d005de9720827ca8964bce449aaf896991950ef8`.
- Kuki Shinobu review evidence — `3ec3fe0cc6fb61574effd7b284c30ce1831949a5e416b9c15714b62ecf2442de`.
- Nahida review evidence — `45b1d648dd7a1c08445882c129291a18f6697edc4646eaabbf1b086e0f6d75b7`.
- Kokomi review evidence — `420f8ddbc2f4b115d1ca79c76706940382a988d9a3003e4c8e723358cb79f8a9`.
- Furina review evidence — `55d58386fb4714ead9c9c3ccd71450063a58dbf0bb7e697b5f7aa4b46db62cd6`.

Reviewed scenario-mechanic evidence, retrieved 2026-07-25:

- KQM TCL, Enemy Shields and Armor — `https://library.keqingmains.com/combat-mechanics/enemy-mechanics/enemy-shields-armor`; used for conservative shield and armor capability constraints; review evidence `ef781d8f0a5dbc680dd9ee1990f07281f75c1530e396c844cbd1ac5d7ffde434`.
- KQM TCL, Enemy Resistances — `https://library.keqingmains.com/combat-mechanics/enemy-mechanics/enemy-resistances`; used for damage-type resistance avoidance; review evidence `a905a6f402b6598ca7309b2cdb23dea011c26000e7bd919169f3f936c3ba5a02`.
- KQM TCL, AoE Scaling — `https://library.keqingmains.com/combat-mechanics/damage/other/aoe-scaling`; used for grouping, ungroupable, and single-target constraints; review evidence `220c39048759b366ff493dc8d158e2ea323ad44bd6c77dec656ffc9dd4e7a80a`.
- KQM TCL, Shields — `https://library.keqingmains.com/combat-mechanics/damage/shields`; used for conservative sustain and interruption-pressure constraints; review evidence `a665bc07bb751828dc085182865b41270b75ebceb621b0a2cdece85278756d5a`.
- KQM TCL Evidence Vault, Enemy Interactions — `https://library.keqingmains.com/evidence/combat-mechanics/enemy-mechanics/enemy-interactions`; used for burrowing and mobile-window constraints; review evidence `756e2059048956bdb94db4c3198eb620110e1f3fa5b1ba1e325be6778ae5f10a`.
- KQM TCL, Cooldowns and Energy — `https://library.keqingmains.com/combat-mechanics/cooldowns` and `https://library.keqingmains.com/combat-mechanics/energy`; used for repeatable multi-wave rotation constraints; review evidence `18bf791ccbc02fd5f3d2157542b987fbefe78af729dd5998ec8ea027984aecc2` and `cda11a4fd811ed2bb85e07f1a178f7045224fa4f58ddaaace27c3ed526f26c44`.
- KQM TCL, Internal Cooldown — `https://library.keqingmains.com/combat-mechanics/internal-cooldown`; used for conservative elemental-application and reaction constraints; review evidence `bc3eedefde42f703d60234115c05d235db3aa61e2940cc013058789f0ebd7e8c`.
- `resources/knowledge/enemy-mechanic-strategies.v1.json` stores capability requirements, preferred archetypes, and role-slot skeletons only. It does not hard-code four-character teams. Every mechanic policy and fact statement is bound to the same canonical-JSON / statement digest review system described above.

Accepted source registry entries, reviewed 2026-07-24:

- `official-genshin` — Genshin Impact official site (`genshin.hoyoverse.com`), accepted for official product and character information.
- `hoyolab-wiki` — HoYoLAB (`hoyolab.com`), accepted for official community and wiki information.
- `kqm-guides` — KeqingMains character guides (`keqingmains.com`); the five fully reviewed v2 strategies use the linked Raiden Shogun, Kuki Shinobu, Nahida, Kokomi, and Furina Quick Guides.
- `kqm-shortlink` — KQM guide directory (`kqm.gg`), registered as an accepted discovery host; it does not substantiate this application's internal review status, and gap entries carry no trusted facts.
- `kqm-library` — KQM Theorycrafting Library (`library.keqingmains.com`), accepted for reviewed mechanics references.

Runtime and development dependencies retain their respective licenses. The application source is licensed under GPL-3.0-or-later; see `LICENSE` and package metadata for dependency notices.

Genshin Impact, HoYoLAB, MiHoYo, and related marks belong to their respective owners. This community project is not affiliated with or endorsed by them.
