import { it } from "node:test";
import { channel } from "node:diagnostics_channel";
import type { IncomingMessage } from "node:http";
import { strictEqual, rejects } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { EnvironmentId, TrimmedNonEmptyString } from "@t3tools/contracts";
import type { CoderHelperConnection } from "@t3tools/coder-cli/helperConnection";
import { makeLocalCoderGateway } from "./server.ts";
for (const kind of ["forward", "helper"] as const) {
  it(
    `refuses replacement when cancelled ${kind} acquisition cannot stop its child`,
    { timeout: 10_000 },
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3-review-cancel-"));
      const configPath = path.join(dir, "config.json");
      const config = {
        version: 1,
        deployments: [{ id: "d", name: "D", url: "https://coder.example.com" }],
        workspaces: [{ id: "w", name: "W", deploymentId: "d", workspace: "user/w" }],
        portForwards: [],
      };
      await fs.writeFile(configPath, JSON.stringify(config));
      const scope = await Effect.runPromise(Scope.make("sequential"));
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let opens = 0;
      let failedReleases = 0;
      let failing = true;
      const connect = () =>
        Effect.gen(function* () {
          const n = ++opens;
          const exited = Promise.withResolvers<{ code: number; signal: null; expected: true }>();
          const close = Effect.suspend(() => {
            if (n === 1 && failing) {
              failedReleases++;
              return Effect.die(new Error("first child still running"));
            }
            exited.resolve({ code: 0, signal: null, expected: true });
            return Effect.void;
          });
          const connection = yield* Effect.acquireRelease(
            Effect.succeed({
              closed: Effect.promise(() => exited.promise),
              close,
              sendRpc: () => Effect.void,
              onRpcMessage: () => () => undefined,
              info: {
                protocolVersion: 1,
                platform: "linux",
                architecture: "x64",
                environment: {
                  environmentId: EnvironmentId.make("test"),
                  label: TrimmedNonEmptyString.make("Workspace"),
                  platform: { os: "linux", arch: "x64" },
                  serverVersion: TrimmedNonEmptyString.make("0.0.33"),
                  capabilities: { repositoryIdentity: true, connectionProbe: true },
                },
              },
            } satisfies CoderHelperConnection),
            () => close,
          );
          if (n === 1) {
            started.resolve();
            yield* Effect.promise(() => release.promise);
          }
          return connection;
        });
      const gateway = await Effect.runPromise(
        makeLocalCoderGateway({
          configPath,
          listWorkspaces: () => Effect.succeed([]),
          probeWorkspace: () => Effect.void,
          restartWorkspace: () => Effect.void,
          ...(kind === "forward" ? { connectPortForward: connect } : { connectHelper: connect }),
        }).pipe(Scope.provide(scope)),
      );
      const post = (url: string, body?: unknown) =>
        fetch(gateway.url + url, {
          method: "POST",
          headers: { Origin: gateway.url, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      const restartPath =
        kind === "forward" ? "/api/port-forwards/f/restart" : "/api/workspaces/w/restart";
      try {
        const setting =
          kind === "helper"
            ? post("/api/workspaces/w/connection")
            : post("/api/config", {
                ...config,
                portForwards: [
                  { id: "f", workspaceId: "w", protocol: "tcp", localPort: 8080, remotePort: 3000 },
                ],
              });
        await started.promise;
        const received = Promise.withResolvers<void>();
        const requests = channel("http.server.request.start");
        let requestCount = 0;
        const onRequest = (message: unknown) => {
          const { request } = message as { request: IncomingMessage };
          if (request.url === restartPath && request.headers.host === new URL(gateway.url).host) {
            // Let the handler claim the lifecycle before releasing acquisition.
            if (++requestCount === 2) setImmediate(() => received.resolve());
          }
        };
        requests.subscribe(onRequest);
        const restarting = post(restartPath);
        const concurrentRestart = post(restartPath);
        try {
          await received.promise;
        } finally {
          requests.unsubscribe(onRequest);
        }
        release.resolve();
        const [saved, restarted, concurrent] = await Promise.all([
          setting,
          restarting,
          concurrentRestart,
        ]);
        strictEqual(concurrent.status, 502);
        strictEqual(failedReleases, 1);
        strictEqual(
          restarted.status,
          502,
          `replacement status=${restarted.status}, opened=${opens}, saved=${saved.status}`,
        );
        strictEqual(opens, 1);
        failing = false;
        strictEqual((await post(restartPath)).status, 200);
        if (kind === "helper")
          strictEqual((await post("/api/workspaces/w/connection")).status, 200);
        strictEqual(opens, 2);
      } finally {
        failing = false;
        release.resolve();
        await Effect.runPromiseExit(Scope.close(scope, Exit.void));
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
}

it(
  "closes retained child scopes and the listener even when one child finalizer defects",
  { timeout: 10_000 },
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "t3-shutdown-defect-"));
    const configPath = path.join(dir, "config.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        deployments: [{ id: "d", name: "D", url: "https://coder.example.com" }],
        workspaces: [{ id: "w", name: "W", deploymentId: "d", workspace: "user/w" }],
        portForwards: [8080, 8081].map((localPort) => ({
          id: `f-${localPort}`,
          workspaceId: "w",
          protocol: "tcp",
          localPort,
          remotePort: 3000,
        })),
      }),
    );
    const scope = await Effect.runPromise(Scope.make("sequential"));
    let opened = 0;
    const finalized = new Set<number>();
    try {
      const gateway = await Effect.runPromise(
        makeLocalCoderGateway({
          configPath,
          connectPortForward: () =>
            Effect.gen(function* () {
              const id = ++opened;
              return yield* Effect.acquireRelease(
                Effect.succeed({ closed: Effect.never, close: Effect.void }),
                () =>
                  Effect.sync(() => {
                    finalized.add(id);
                    if (id === 1) throw new Error("child finalizer failed");
                  }),
              );
            }),
        }).pipe(Scope.provide(scope)),
      );
      strictEqual(opened, 2);
      const response = await fetch(`${gateway.url}/api/config`);
      await response.text();
      // Parent scope defects must not prevent listener cleanup.
      await Effect.runPromiseExit(Scope.close(scope, Exit.void));
      strictEqual(finalized.size, 2);
      await rejects(fetch(`${gateway.url}/api/config`), /fetch failed/);
    } finally {
      await Effect.runPromiseExit(Scope.close(scope, Exit.void));
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
