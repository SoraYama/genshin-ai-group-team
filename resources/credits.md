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

Knowledge page integrity, retrieved 2026-07-24:

- Citation `contentSha256` is the SHA-256 of the final HTTPS response body after redirects and HTTP content decoding, exactly as saved by `curl -fL --compressed` with the project knowledge-review user agent. It is snapshot evidence, not a claim that third-party pages are immutable.
- Raiden Shogun Quick Guide — `95e6ce3312a53f81d933cd246b50f1b7b94bf3840842e25a2d9facee8df90923`.
- Kuki Shinobu Quick Guide — `0fd7391528ba84cd91dfc622cb3fc2ce85ca49517b97e0130ee2037b4520290c`.
- Nahida Quick Guide — `0922afe7918c019227edc392fc424020745ee1bcfcf077c41c7f8a5e3550ab9e`.
- Kokomi Quick Guide — `656c5eeec552c8c9a08b49dff657989bbf489115a24c013c07921cd642e45353`.
- Furina Quick Guide — `ba02542cec1daff3357a3f177a533ade8dc564fd08d873d3e6709b9b54647105`.

Accepted source registry entries, reviewed 2026-07-24:

- `official-genshin` — Genshin Impact official site (`genshin.hoyoverse.com`), accepted for official product and character information.
- `hoyolab-wiki` — HoYoLAB (`hoyolab.com`), accepted for official community and wiki information.
- `kqm-guides` — KeqingMains character guides (`keqingmains.com`); the five fully reviewed v2 strategies use the linked Raiden Shogun, Kuki Shinobu, Nahida, Kokomi, and Furina Quick Guides.
- `kqm-shortlink` — KQM guide directory (`kqm.gg`), registered as an accepted discovery host; it does not substantiate this application's internal review status, and gap entries carry no trusted facts.
- `kqm-library` — KQM Theorycrafting Library (`library.keqingmains.com`), accepted for reviewed mechanics references.

Runtime and development dependencies retain their respective licenses. The application source is licensed under GPL-3.0-or-later; see `LICENSE` and package metadata for dependency notices.

Genshin Impact, HoYoLAB, MiHoYo, and related marks belong to their respective owners. This community project is not affiliated with or endorsed by them.
