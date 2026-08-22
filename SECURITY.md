# Security policy

T3 Coder is a private-purpose, Coder-only fork. It is not an approved Goldman Sachs application by
virtue of this repository; users must obtain the reviews required by their employer before using it
with work systems or data.

## Supported boundary

Security fixes target the `coder-only` branch and the architecture documented in
[`docs/internals/coder-only.md`](./docs/internals/coder-only.md). Electron, hosted services, generic
SSH, local Claude providers, file transfer, MCP integrations, and hosted source-control operations
are outside the supported design.

## Reporting

Report a suspected vulnerability privately through this repository's GitHub Security Advisory
workflow. Do not include employer secrets, credentials, source code, customer data, or workspace
logs in the report. If private reporting is unavailable, open a minimal issue asking the maintainer
to enable a private channel without disclosing the vulnerability.

## Dependency review

The lockfile is authoritative. Reviewers can reproduce the production checks with:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm audit --prod
pnpm licenses list --prod
pnpm generate:sbom
```

The project has no root install lifecycle script. `pnpm-workspace.yaml` denies dependency build
scripts except the explicitly listed packages. The checked-in CycloneDX SBOM covers the production
dependency closure represented by the lockfile.
