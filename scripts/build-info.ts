import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Build-time identity only; the gateway and helper never run Git to read it. */
export function readBuildVersion(): string {
  const cwd = fileURLToPath(new URL("../", import.meta.url));
  const { version } = JSON.parse(
    readFileSync(new URL("../apps/server/package.json", import.meta.url), "utf8"),
  ) as { version: string };
  try {
    const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).length > 0;
    return `${version}+${commit}${dirty ? ".dirty" : ""}`;
  } catch {
    return `${version}+source`;
  }
}
