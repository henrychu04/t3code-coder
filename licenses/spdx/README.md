# Bundled SPDX license texts

These source files contain the `licenseId` and `licenseText` fields from SPDX License List
v3.28.0, pinned to revision `c4a7237ec8f4654e867546f9f409749300f1bf4c` of
[spdx/license-list-data](https://github.com/spdx/license-list-data/tree/c4a7237ec8f4654e867546f9f409749300f1bf4c/json/details).
License text is preserved; package-specific copyright notices are applied during manifest generation.

Normal builds read these checked-in files without downloading license data. When adding a license
to `third-party-licenses.config.json`, run `pnpm licenses:sync` with network access and commit the
new source file. Version and revision pins live in `apps/web/vite/third-party-licenses.ts`.
