# Client Runtime

Shared browser-client behavior for the Coder-only web application. Public APIs are organized by
package subpath. The package intentionally has no root export.

## Public subpaths

| Subpath          | Responsibility                                                   |
| ---------------- | ---------------------------------------------------------------- |
| `connection`     | Targets, catalog, supervision, retries, registry, and onboarding |
| `environment`    | Environment identity, descriptors, endpoints, and scoped keys    |
| `errors`         | Shared client error inspection                                   |
| `operations`     | Multi-step application workflows                                 |
| `platform`       | Browser platform capability contracts                            |
| `rpc`            | Loopback WebSocket RPC clients, protocol, and subscriptions      |
| `state/<domain>` | Focused shared state, retention, reducers, and Atom constructors |

## Dependency direction

The web application provides `platform` services. `connection` composes those capabilities with
the loopback RPC transport to supervise the selected Coder workspace. Independent `state` modules
consume the connection registry and expose focused state or Atom constructors.

Applications should import the narrowest relevant subpath. There is no broad
`state` export: use domain paths such as `state/shell`, `state/threads`,
`state/terminal`, or `state/vcs`. Subpath indices and explicitly exported domain
files are public API boundaries; all other files remain implementation details.
