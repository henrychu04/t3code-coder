# Security policy

T3 Coder is designed so repositories, agent sessions, terminals, and durable application data stay
inside authenticated Coder workspaces. The local browser interface is available only through IPv4
loopback, and T3 Coder does not provide general file transfer or hosted integrations.

This is a private-purpose fork. It is not an approved Goldman Sachs application by virtue of this
repository; users must obtain the reviews required by their employer before using it with work
systems or data.

## Supported boundary

Security fixes target the `coder-only` branch and the architecture documented in
[`docs/internals/coder-only.md`](./docs/internals/coder-only.md). Native and mobile clients, hosted
services, generic SSH, locally running providers, general file transfer, MCP and app integrations,
and hosted source-control operations are outside the supported design.

See [Product decisions and upstream differences](./docs/product-differences.md) for the
user-visible boundary and [Security and data handling](./docs/compliance-review.md) for review
evidence.

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
