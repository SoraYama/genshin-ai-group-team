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
- These digests make the bundled reviewed snapshot locally tamper-evident across the files loaded together; they are not an external signature or independent trust root. They cover the committed evidence and archetype policy, **not upstream page HTML** or future upstream changes.
- Raiden Shogun review evidence — `db0744793ccdb9ed0e65a97fc6022d307a0c79fbda2456db55447bff12f666b0`.
- Kuki Shinobu review evidence — `12588b41142ee5ba89b47495f36eec1aa29b3e27e74e8e0e66df5fcf7b23a495`.
- Nahida review evidence — `3fb6001e9722b6f4aa27463d69cbde8d8b4b0b51005984347059e9eb2ee68847`.
- Kokomi review evidence — `03068357cf5f0cffae7f12bb84ee0d25a21693758d5eca2c6c309efcc4f89d43`.
- Furina review evidence — `30e7fc76ca220490d524e32406ac659e75113a7e9b6d4c2c8fed319b28162077`.

Accepted source registry entries, reviewed 2026-07-24:

- `official-genshin` — Genshin Impact official site (`genshin.hoyoverse.com`), accepted for official product and character information.
- `hoyolab-wiki` — HoYoLAB (`hoyolab.com`), accepted for official community and wiki information.
- `kqm-guides` — KeqingMains character guides (`keqingmains.com`); the five fully reviewed v2 strategies use the linked Raiden Shogun, Kuki Shinobu, Nahida, Kokomi, and Furina Quick Guides.
- `kqm-shortlink` — KQM guide directory (`kqm.gg`), registered as an accepted discovery host; it does not substantiate this application's internal review status, and gap entries carry no trusted facts.
- `kqm-library` — KQM Theorycrafting Library (`library.keqingmains.com`), accepted for reviewed mechanics references.

Runtime and development dependencies retain their respective licenses. The application source is licensed under GPL-3.0-or-later; see `LICENSE` and package metadata for dependency notices.

Genshin Impact, HoYoLAB, MiHoYo, and related marks belong to their respective owners. This community project is not affiliated with or endorsed by them.
