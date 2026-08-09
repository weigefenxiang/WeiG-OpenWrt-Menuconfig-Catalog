# Compatibility Evidence Rules

`compatibility.json` records package-compatibility facts that the upstream Catalog/Kconfig data cannot currently express but that real build evidence has confirmed. It is not a second dependency database and must not contain plugin presentation data.

## Data-authority boundary

Before adding a field, inspect Kconfig, Catalog relations, the Catalog index, and the existing runtime model. Existing facts must be referenced by stable IDs. Do not copy symbol types, N/M/Y states, display names, translations, dependencies, providers, conflicts, hashes, byte counts, or generation timestamps.

Rules allow only `id`, `kind`, `scope`, `if`, `packages`, `paths`, and `refs`. The web client resolves package IDs through the Catalog model, reads config-symbol capabilities and dependency facts there, and derives the smallest valid change through the existing intent engine.

## Fields

- `id`: stable rule ID; ownership rules use `OWN-xxxx`.
- `kind`: version 1 accepts only `ownership`.
- `scope`: mapping from Source IDs to exact branch-name arrays.
- `if`: an additional condition evaluated by the existing Kconfig expression engine.
- `packages`: real package IDs involved in the compatibility problem.
- `paths`: confirmed absolute paths with duplicate ownership.
- `refs`: short evidence references such as a GitHub Actions Run ID; never copy complete logs.

## Lifecycle

Every rule requires real evidence. Verify an actual failure before adding another branch; similar source layouts are not sufficient. When upstream fixes the issue, narrow the scope or remove the rule immediately instead of retaining a zombie rule.

Manual evidence rules are web-side soft warnings. Users may apply a plan derived by the Catalog engine, adjust states inside the modal, or keep their current selection. The build backend must not turn them into package locks.

Publication creates one `compatibility.json.gz` directly in the `catalog-fix`, `catalog-dev`, `catalog-staging`, or `catalog-data` data branch. Preview channels do not create Releases.

Normalized JSON has a hard 512 KiB uncompressed limit. The index records both compressed and uncompressed byte counts, and clients verify both. Only when the file approaches this limit should an explicit schema migration split it by Source or Source/Branch; do not maintain empty parallel datasets in advance.

中文说明：[COMPATIBILITY.md](COMPATIBILITY.md)
