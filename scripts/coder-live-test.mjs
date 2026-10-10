import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHTTP from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const CLI_VERSION = "2.25.3";
const SERVER_VERSION = "2.34.5";
const REMOTE_PORT = 18080;
const scriptDirectory = NodePath.dirname(fileURLToPath(import.meta.url));
const templateDirectory = NodePath.join(scriptDirectory, "coder-live-template");
const checkoutRoot = NodePath.dirname(scriptDirectory);
const repositoryRoot = checkoutRoot;
// Codex sessions supply a stable ID. Manual sessions can set the override when multiple
// harnesses intentionally run from the same checkout; separate T3 worktrees are isolated by path.
const sessionSource =
  process.env.T3_CODER_LIVE_SESSION?.trim() ||
  process.env.CODEX_SESSION_ID?.trim() ||
  process.env.CODEX_THREAD_ID?.trim() ||
  checkoutRoot;
const sessionNamespace = createHash("sha256").update(sessionSource).digest("hex");
const resourceSuffix = sessionNamespace.slice(0, 24);
const COLIMA_PROFILE = `t3-coder-${resourceSuffix}`;
const DEPLOYMENT_ID = `local-${resourceSuffix}`;
const WORKSPACE_ID = `live-${resourceSuffix}`;
const TEMPLATE_NAME = `pf-${resourceSuffix}`;
const PORT_FORWARD_ID = `http-${resourceSuffix}`;
const DOCKER_IMAGE = `t3-coder-port-forward-test:${SERVER_VERSION}-${resourceSuffix}`;
const RESPONSE_MARKER = `t3-coder-real-port-forward-ok-${resourceSuffix}`;
const defaultStateBaseRoot = NodePath.join(
  NodeOS.homedir(),
  "Library",
  "Application Support",
  "t3-coder-live-test",
);
const stateBaseRoot = process.env.T3_CODER_LIVE_ROOT?.trim() || defaultStateBaseRoot;
const stateRoot = NodePath.join(stateBaseRoot, "sessions", sessionNamespace);
const portClaimsDirectory = NodePath.join(defaultStateBaseRoot, "port-claims");
const downloadsDirectory = NodePath.join(stateRoot, "downloads");
const serverConfigDirectory = NodePath.join(stateRoot, "server-config");
const serverCacheDirectory = NodePath.join(stateRoot, "server-cache");
const gatewayDirectory = NodePath.join(stateRoot, "gateway");
const gatewayConfigPath = NodePath.join(gatewayDirectory, "config.json");
const coderProfileDirectory = NodePath.join(gatewayDirectory, "coder-profiles", DEPLOYMENT_ID);
const serverPidPath = NodePath.join(stateRoot, "server.pid");
const serverLogPath = NodePath.join(stateRoot, "server.log");
const templateFingerprintPath = NodePath.join(stateRoot, "template-fingerprint");

function coderExecutable(version) {
  return NodePath.join(stateRoot, `coder-${version}`, "bin", "coder");
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .join("\n")
      .trim();
    throw new Error(
      `${executable} ${args.join(" ")} exited with ${String(result.status)}.${detail ? ` ${detail}` : ""}`,
    );
  }
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function succeeds(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: "ignore",
  });
  return result.status === 0;
}

function parseJsonArray(output, description) {
  if (output.length === 0) return [];
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) throw new Error(`${description} did not return a JSON array.`);
  return parsed;
}

function requireExecutable(executable) {
  if (!succeeds("which", [executable])) {
    throw new Error(`Missing required executable: ${executable}`);
  }
}

async function pathExists(path) {
  try {
    await NodeFSP.access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectories() {
  await Promise.all(
    [
      downloadsDirectory,
      serverConfigDirectory,
      serverCacheDirectory,
      coderProfileDirectory,
      portClaimsDirectory,
    ].map((directory) => NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 })),
  );
}

function portClaimPath(port) {
  return NodePath.join(portClaimsDirectory, `${String(port)}.json`);
}

async function readPortClaim(path) {
  try {
    const parsed = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    if (
      typeof parsed.sessionNamespace !== "string" ||
      typeof parsed.role !== "string" ||
      !Number.isInteger(parsed.port)
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

async function findPortClaim(role) {
  if (!(await pathExists(portClaimsDirectory))) return undefined;
  const entries = await NodeFSP.readdir(portClaimsDirectory);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const claim = await readPortClaim(NodePath.join(portClaimsDirectory, entry));
    if (claim?.sessionNamespace === sessionNamespace && claim.role === role) return claim;
  }
  return undefined;
}

async function releasePortClaim(claim) {
  const path = portClaimPath(claim.port);
  const current = await readPortClaim(path);
  if (
    current?.sessionNamespace === sessionNamespace &&
    current.role === claim.role &&
    current.port === claim.port
  ) {
    await NodeFSP.rm(path, { force: true });
  }
}

async function claimAvailablePort(role) {
  await NodeFSP.mkdir(portClaimsDirectory, { recursive: true, mode: 0o700 });
  const existing = await findPortClaim(role);
  if (existing !== undefined) return existing;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = await findAvailablePort();
    const claim = { sessionNamespace, role, port };
    let handle;
    try {
      handle = await NodeFSP.open(portClaimPath(port), "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(claim)}\n`, "utf8");
      return claim;
    } catch (cause) {
      if (cause?.code !== "EEXIST") throw cause;
    } finally {
      await handle?.close();
    }
  }
  throw new Error(`Could not claim an isolated host port for ${role}.`);
}

async function usingPortClaim(role, use) {
  const claim = await claimAvailablePort(role);
  try {
    return await use(claim);
  } finally {
    await releasePortClaim(claim);
  }
}

async function ensureCoderBinary(version) {
  const executable = coderExecutable(version);
  if (await pathExists(executable)) {
    const versionOutput = run(executable, ["version"]);
    if (!versionOutput.includes(version)) {
      throw new Error(`Expected Coder ${version}, received: ${versionOutput}`);
    }
    return;
  }

  const asset = `coder_${version}_darwin_arm64.zip`;
  const archivePath = NodePath.join(downloadsDirectory, asset);
  const checksumsPath = NodePath.join(downloadsDirectory, `coder_${version}_checksums.txt`);
  const releaseRoot = `https://github.com/coder/coder/releases/download/v${version}`;
  console.log(`Downloading Coder ${version}…`);
  run("curl", [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--output",
    archivePath,
    `${releaseRoot}/${asset}`,
  ]);
  run("curl", [
    "--fail",
    "--location",
    "--silent",
    "--show-error",
    "--output",
    checksumsPath,
    `${releaseRoot}/coder_${version}_checksums.txt`,
  ]);
  const checksumLine = (await NodeFSP.readFile(checksumsPath, "utf8"))
    .split(/\r?\n/u)
    .find((line) => line.endsWith(` ${asset}`));
  if (checksumLine === undefined) throw new Error(`Official checksum is missing for ${asset}.`);
  const actualChecksum = run("shasum", ["-a", "256", archivePath]).split(/\s+/u)[0];
  const expectedChecksum = checksumLine.split(/\s+/u)[0];
  if (actualChecksum !== expectedChecksum) throw new Error(`Checksum mismatch for ${asset}.`);

  const destination = NodePath.dirname(executable);
  await NodeFSP.mkdir(destination, { recursive: true, mode: 0o700 });
  run("ditto", ["-xk", archivePath, destination]);
  await NodeFSP.chmod(executable, 0o755);
  const versionOutput = run(executable, ["version"]);
  if (!versionOutput.includes(version)) {
    throw new Error(`Expected Coder ${version}, received: ${versionOutput}`);
  }
}

function serverEnvironment() {
  return {
    ...process.env,
    CODER_CONFIG_DIR: serverConfigDirectory,
    CODER_CACHE_DIRECTORY: serverCacheDirectory,
    CODER_TELEMETRY_ENABLE: "false",
    CODER_UPDATE_CHECK: "false",
    CODER_AI_GATEWAY_ENABLED: "false",
  };
}

async function runningServerVersion(coderUrl) {
  try {
    const response = await fetch(`${coderUrl}/api/v2/buildinfo`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return undefined;
    const buildInfo = await response.json();
    return typeof buildInfo.version === "string" ? buildInfo.version : undefined;
  } catch {
    return undefined;
  }
}

async function serverIsReady(coderUrl) {
  return (await runningServerVersion(coderUrl))?.startsWith(`v${SERVER_VERSION}`) === true;
}

function processCommand(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function commandOwnsCoderServer(command, port, coderUrl) {
  return (
    command.includes(coderExecutable(SERVER_VERSION)) &&
    command.includes(" --no-open server ") &&
    command.includes(` --http-address 127.0.0.1:${String(port)} `) &&
    command.includes(` --access-url ${coderUrl} `)
  );
}

async function ownedServerPid(serverClaim, coderUrl) {
  if (!(await pathExists(serverPidPath))) return undefined;
  const pid = Number.parseInt((await NodeFSP.readFile(serverPidPath, "utf8")).trim(), 10);
  if (!Number.isInteger(pid) || pid <= 1) return undefined;
  return commandOwnsCoderServer(processCommand(pid), serverClaim.port, coderUrl) ? pid : undefined;
}

async function waitFor(predicate, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function startColima() {
  if (succeeds("colima", ["status", COLIMA_PROFILE])) return;
  console.log(`Starting persistent Colima profile ${COLIMA_PROFILE}…`);
  run(
    "colima",
    [
      "start",
      COLIMA_PROFILE,
      "--arch",
      "aarch64",
      "--vm-type",
      "vz",
      "--vz-rosetta",
      "--cpu",
      "2",
      "--memory",
      "4",
      "--disk",
      "30",
      "--runtime",
      "docker",
    ],
    { inherit: true },
  );
}

async function startCoderServer() {
  let serverClaim;
  let coderUrl;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    serverClaim = await claimAvailablePort("coder-server");
    coderUrl = `http://127.0.0.1:${String(serverClaim.port)}`;
    const ownerPid = await ownedServerPid(serverClaim, coderUrl);
    const runningVersion = await runningServerVersion(coderUrl);
    if (ownerPid !== undefined) {
      if (runningVersion?.startsWith(`v${SERVER_VERSION}`)) return coderUrl;
      if (runningVersion !== undefined) {
        throw new Error(
          `Owned Coder server ${String(ownerPid)} reported ${runningVersion}; expected Coder ${SERVER_VERSION}.`,
        );
      }
      await waitFor(
        async () => {
          if (await serverIsReady(coderUrl)) return true;
          if ((await ownedServerPid(serverClaim, coderUrl)) === undefined) {
            throw new Error(`Owned Coder server ${String(ownerPid)} exited before becoming ready.`);
          }
          return false;
        },
        "the owned local Coder server",
        90_000,
      );
      return coderUrl;
    }
    if (runningVersion !== undefined) {
      await releasePortClaim(serverClaim);
      continue;
    }
    if (await portCanBeBound(serverClaim.port)) break;
    await releasePortClaim(serverClaim);
  }
  if (serverClaim === undefined || coderUrl === undefined) {
    throw new Error("Could not claim an isolated host port for the Coder server.");
  }
  const serverExecutable = coderExecutable(SERVER_VERSION);
  const logFd = NodeFS.openSync(serverLogPath, "a", 0o600);
  const child = spawn(
    serverExecutable,
    [
      "--no-open",
      "server",
      "--http-address",
      `127.0.0.1:${String(serverClaim.port)}`,
      "--access-url",
      coderUrl,
      "--external-auth-github-default-provider-enable=false",
    ],
    {
      detached: true,
      env: serverEnvironment(),
      shell: false,
      stdio: ["ignore", logFd, logFd],
    },
  );
  NodeFS.closeSync(logFd);
  if (child.pid === undefined) throw new Error("Coder server did not provide a process ID.");
  await NodeFSP.writeFile(serverPidPath, `${child.pid}\n`, { mode: 0o600 });
  child.unref();
  await waitFor(
    async () => {
      if (await serverIsReady(coderUrl)) return true;
      if (child.exitCode !== null) {
        throw new Error(`The local Coder server exited with ${String(child.exitCode)}.`);
      }
      return false;
    },
    "the local Coder server",
    90_000,
  );
  return coderUrl;
}

function coderArgs(coderUrl, ...args) {
  return [
    "--global-config",
    coderProfileDirectory,
    "--disable-network-telemetry",
    "--disable-direct-connections",
    "--no-version-warning",
    "--url",
    coderUrl,
    ...args,
  ];
}

async function ensureAuthentication(coderUrl) {
  const cli = coderExecutable(CLI_VERSION);
  if (succeeds(cli, coderArgs(coderUrl, "whoami"))) return;
  const password = randomBytes(24).toString("base64url");
  run(
    cli,
    [
      "--global-config",
      coderProfileDirectory,
      "--disable-network-telemetry",
      "--disable-direct-connections",
      "--no-version-warning",
      "login",
      coderUrl,
      "--no-open",
      "--first-user-email",
      "t3live@localhost.invalid",
      "--first-user-username",
      "t3live",
      "--first-user-full-name",
      "T3 Live Test",
      "--first-user-trial=false",
    ],
    { env: { ...process.env, CODER_FIRST_USER_PASSWORD: password } },
  );
}

async function ensureWorkspace(coderUrl) {
  const cli = coderExecutable(CLI_VERSION);
  const dockerSocket = `unix://${NodePath.join(NodeOS.homedir(), ".colima", COLIMA_PROFILE, "docker.sock")}`;
  console.log("Building the Linux/amd64 test workspace image…");
  run(
    "docker",
    [
      "--context",
      `colima-${COLIMA_PROFILE}`,
      "build",
      "--platform",
      "linux/amd64",
      "--tag",
      DOCKER_IMAGE,
      "--build-arg",
      `RESPONSE_MARKER=${RESPONSE_MARKER}`,
      ".",
    ],
    { cwd: templateDirectory, inherit: true },
  );
  const image = JSON.parse(
    run("docker", [
      "--context",
      `colima-${COLIMA_PROFILE}`,
      "image",
      "inspect",
      "--format",
      "{{json .}}",
      DOCKER_IMAGE,
    ]),
  );
  const stableImageIdentity = JSON.stringify({
    architecture: image.Architecture,
    config: image.Config,
    os: image.Os,
    rootFS: image.RootFS,
  });
  const templateFingerprint = createHash("sha256")
    .update(stableImageIdentity)
    .update("\0")
    .update(dockerSocket)
    .update("\0")
    .update(await NodeFSP.readFile(NodePath.join(templateDirectory, "main.tf")))
    .digest("hex");
  const previousFingerprint = (await pathExists(templateFingerprintPath))
    ? (await NodeFSP.readFile(templateFingerprintPath, "utf8")).trim()
    : undefined;
  const templates = parseJsonArray(
    run(cli, coderArgs(coderUrl, "templates", "list", "--output", "json")),
    "Coder templates list",
  );
  const templateChanged =
    !templates.some((template) => template.Template?.name === TEMPLATE_NAME) ||
    previousFingerprint !== templateFingerprint;
  if (templateChanged) {
    run(
      cli,
      coderArgs(
        coderUrl,
        "templates",
        "push",
        TEMPLATE_NAME,
        "--directory",
        templateDirectory,
        "--variable",
        `docker_socket=${dockerSocket}`,
        "--variable",
        `image_name=${DOCKER_IMAGE}`,
        "--ignore-lockfile",
        "--yes",
      ),
    );
  }

  const workspaces = parseJsonArray(
    run(cli, coderArgs(coderUrl, "list", "--output", "json")),
    "Coder workspace list",
  );
  const workspaceExists = workspaces.some((workspace) => workspace.name === WORKSPACE_ID);
  if (!workspaceExists) {
    run(cli, coderArgs(coderUrl, "create", WORKSPACE_ID, "--template", TEMPLATE_NAME, "--yes"), {
      inherit: true,
    });
  } else if (templateChanged) {
    console.log(`Updating ${WORKSPACE_ID} to the current live-test template…`);
    run(cli, coderArgs(coderUrl, "update", WORKSPACE_ID), { inherit: true });
  }
  await NodeFSP.writeFile(templateFingerprintPath, `${templateFingerprint}\n`, { mode: 0o600 });
  run(cli, coderArgs(coderUrl, "ssh", "--wait", "yes", WORKSPACE_ID, "--", "true"));
}

async function setup() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The reusable real-Coder harness currently supports Apple Silicon macOS only.");
  }
  for (const executable of ["colima", "docker", "curl", "ditto", "shasum"]) {
    requireExecutable(executable);
  }
  await ensureDirectories();
  await Promise.all([ensureCoderBinary(CLI_VERSION), ensureCoderBinary(SERVER_VERSION)]);
  await startColima();
  const coderUrl = await startCoderServer();
  await ensureAuthentication(coderUrl);
  await ensureWorkspace(coderUrl);
  console.log(`Session-isolated Coder environment is ready in ${stateRoot}`);
  return coderUrl;
}

async function findAvailablePort() {
  const server = NodeNet.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Could not reserve a test port.");
  await new Promise((resolve, reject) =>
    server.close((cause) => (cause ? reject(cause) : resolve())),
  );
  return address.port;
}

async function portCanBeBound(port) {
  const server = NodeNet.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    return true;
  } catch (cause) {
    if (cause?.code === "EADDRINUSE") return false;
    throw cause;
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) =>
        server.close((cause) => (cause ? reject(cause) : resolve())),
      );
    }
  }
}

async function forwardedResponse(port) {
  return await new Promise((resolve, reject) => {
    const request = NodeHTTP.get(
      { hostname: "127.0.0.1", port, path: "/", timeout: 1_000 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve(body.trim()));
      },
    );
    request.once("timeout", () => request.destroy(new Error("request timed out")));
    request.once("error", reject);
  });
}

async function portIsClosed(port) {
  try {
    await forwardedResponse(port);
    return false;
  } catch {
    return true;
  }
}

async function testPortForward() {
  const [{ saveCoderProfileConfig }, { startLocalCoderGateway }] = await Promise.all([
    import("../packages/coder-cli/src/configStore.ts"),
    import("../apps/coder-gateway/src/testUtils/gateway.ts"),
  ]);
  const coderUrl = await setup();
  await usingPortClaim(`port-forward-${randomBytes(12).toString("hex")}`, async (forwardClaim) => {
    const localPort = forwardClaim.port;
    await saveCoderProfileConfig(gatewayConfigPath, {
      version: 1,
      deployments: [
        {
          id: DEPLOYMENT_ID,
          name: "Local real-Coder test",
          url: coderUrl,
          executable: coderExecutable(CLI_VERSION),
        },
      ],
      workspaces: [
        {
          id: WORKSPACE_ID,
          name: "T3 live test",
          deploymentId: DEPLOYMENT_ID,
          workspace: WORKSPACE_ID,
        },
      ],
      portForwards: [
        {
          id: PORT_FORWARD_ID,
          workspaceId: WORKSPACE_ID,
          protocol: "tcp",
          localPort,
          remotePort: REMOTE_PORT,
        },
      ],
    });

    const gateway = await startLocalCoderGateway({ configPath: gatewayConfigPath });
    try {
      await waitFor(
        async () => {
          try {
            return (await forwardedResponse(localPort)) === RESPONSE_MARKER;
          } catch {
            return false;
          }
        },
        "the real Coder port forward",
        45_000,
      );
      const status = await fetch(`${gateway.url}/api/port-forwards`).then((response) =>
        response.json(),
      );
      const forwardStatus = status.portForwards?.find((entry) => entry.id === PORT_FORWARD_ID);
      if (forwardStatus?.status !== "running") {
        throw new Error(`Expected a running port forward, received: ${JSON.stringify(status)}`);
      }

      const restartResponse = await fetch(
        `${gateway.url}/api/port-forwards/${PORT_FORWARD_ID}/restart`,
        {
          method: "POST",
          headers: { Origin: gateway.url },
        },
      );
      if (!restartResponse.ok)
        throw new Error(`Port-forward restart returned ${restartResponse.status}.`);
      await waitFor(
        async () => {
          try {
            return (await forwardedResponse(localPort)) === RESPONSE_MARKER;
          } catch {
            return false;
          }
        },
        "the restarted real Coder port forward",
        45_000,
      );
    } finally {
      await gateway.close();
    }
    await waitFor(() => portIsClosed(localPort), "the gateway to close its port forward", 15_000);
    console.log(
      `PASS: Coder CLI ${CLI_VERSION} forwarded 127.0.0.1:${localPort} to Coder ${SERVER_VERSION} workspace port ${REMOTE_PORT}, restarted it, and closed it with the gateway.`,
    );
  });
}

async function serve() {
  const [{ saveCoderProfileConfig }, { startLocalCoderGateway }] = await Promise.all([
    import("../packages/coder-cli/src/configStore.ts"),
    import("../apps/coder-gateway/src/testUtils/gateway.ts"),
  ]);
  const coderUrl = await setup();
  await saveCoderProfileConfig(gatewayConfigPath, {
    version: 1,
    deployments: [
      {
        id: DEPLOYMENT_ID,
        name: "Local real-Coder test",
        url: coderUrl,
        executable: coderExecutable(CLI_VERSION),
      },
    ],
    workspaces: [
      {
        id: WORKSPACE_ID,
        name: "T3 live test",
        deploymentId: DEPLOYMENT_ID,
        workspace: WORKSPACE_ID,
      },
    ],
    portForwards: [],
  });

  const gateway = await startLocalCoderGateway({
    configPath: gatewayConfigPath,
    staticDir: NodePath.join(repositoryRoot, "apps", "web", "dist"),
    helperBundlePath: NodePath.join(
      repositoryRoot,
      "apps",
      "coder-helper",
      "dist",
      "workspace-helper",
    ),
  });
  console.log(`T3 Coder live-test gateway listening on ${gateway.url}`);
  console.log(`Gateway PID: ${String(process.pid)}`);

  await new Promise((resolve, reject) => {
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void gateway.close().then(resolve, reject);
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

async function stop() {
  const serverClaim = await findPortClaim("coder-server");
  if (await pathExists(serverPidPath)) {
    const pid = Number.parseInt((await NodeFSP.readFile(serverPidPath, "utf8")).trim(), 10);
    if (Number.isInteger(pid) && pid > 1 && serverClaim !== undefined) {
      const coderUrl = `http://127.0.0.1:${String(serverClaim.port)}`;
      if (commandOwnsCoderServer(processCommand(pid), serverClaim.port, coderUrl)) {
        process.kill(pid, "SIGTERM");
        await waitFor(
          () => {
            try {
              process.kill(pid, 0);
              return false;
            } catch {
              return true;
            }
          },
          "the local Coder server to stop",
          15_000,
        );
      }
    }
    await NodeFSP.rm(serverPidPath, { force: true });
  }
  if (succeeds("colima", ["status", COLIMA_PROFILE])) {
    run("colima", ["stop", COLIMA_PROFILE], { inherit: true });
  }
  if (serverClaim !== undefined) await releasePortClaim(serverClaim);
  console.log("Session-isolated Coder environment stopped; persistent state was retained.");
}

async function status() {
  const serverClaim = await findPortClaim("coder-server");
  const coderUrl =
    serverClaim === undefined ? undefined : `http://127.0.0.1:${String(serverClaim.port)}`;
  console.log(`Session: ${sessionNamespace}`);
  console.log(`State: ${stateRoot}`);
  console.log(`Colima: ${succeeds("colima", ["status", COLIMA_PROFILE]) ? "running" : "stopped"}`);
  const serverVersion = coderUrl === undefined ? undefined : await runningServerVersion(coderUrl);
  console.log(`Coder server: ${serverVersion ?? "stopped"}`);
  for (const version of [CLI_VERSION, SERVER_VERSION]) {
    console.log(
      `Coder ${version}: ${(await pathExists(coderExecutable(version))) ? "installed" : "missing"}`,
    );
  }
}

async function main(command = process.argv[2] ?? "test") {
  switch (command) {
    case "setup":
      await setup();
      break;
    case "test":
      await testPortForward();
      break;
    case "serve":
      await serve();
      break;
    case "status":
      await status();
      break;
    case "stop":
      await stop();
      break;
    default:
      throw new Error("Usage: node scripts/coder-live-test.mjs [setup|test|serve|status|stop]");
  }
}

if (
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}

export {
  claimAvailablePort,
  commandOwnsCoderServer,
  findPortClaim,
  parseJsonArray,
  releasePortClaim,
  usingPortClaim,
};
