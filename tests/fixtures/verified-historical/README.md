# Verified historical advisor facts

This directory freezes small, attributed gameplay facts used by the release gate. It does not
copy page prose or images, and it is not shipped in the application payload.

The snapshots prove stable rule shapes against published historical seasons. They must not be
presented as the current live production scenario. `currentProductionScenarioAvailable: false`
remains explicit until a separately maintained, source-verified current-data repository exists.
Canonical enemy IDs are intentionally absent: the cited pages provide localized enemy facts, but
this repository does not yet have a verified enemy entity catalog. Current publication and the
`unknown enemy ID = 0` release check therefore remain an external data-pipeline blocker rather
than a synthetic pass.

Source facts are attributed to Genshin Impact Wiki contributors under CC BY-SA 3.0. URLs,
snapshot dates, retrieval date, and attribution are stored beside the facts.
