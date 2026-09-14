import * as Cause from "effect/Cause";

import { safeErrorLogAttributes, type SafeErrorLogAttributes } from "./safeLog.ts";

export interface ErrorDiagnostic extends SafeErrorLogAttributes {
  readonly source: string;
  readonly timestamp: string;
  readonly message: string;
}

let reporter: ((diagnostic: ErrorDiagnostic) => void) | undefined;
let reported = new WeakSet<object>();

/** Diagnostics are opt-in at the app entry point; they never send or persist anything. */
export function setErrorDiagnosticReporter(next: typeof reporter): () => void {
  const previous = reporter;
  reporter = next;
  reported = new WeakSet();
  return () => {
    reporter = previous;
    reported = new WeakSet();
  };
}

function diagnosticMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  // Keep the human-readable reason, never arbitrary error fields, request bodies, or causes.
  return message
    .replace(/https?:\/\/[^\s)]+/gi, (value) => {
      try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[redacted URL]";
      }
    })
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(
      /\b((?:[\w-]*token|[\w-]*secret|password|api[_-]?key|authorization|cookie))\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[redacted]",
    )
    .replace(/\b(?:glpat-|gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 2_000);
}

export function reportErrorDiagnostic(source: string, error: unknown): void {
  if (reporter === undefined) return;
  try {
    if (typeof error === "object" && error !== null) {
      // RPC, command, and global handlers can all see the same failure.
      if (reported.has(error)) return;
      reported.add(error);
      if (error instanceof Error && error.name === "AbortError") return;
    }
    reporter({
      ...safeErrorLogAttributes(error),
      source,
      timestamp: new Date().toISOString(),
      message: diagnosticMessage(error),
    });
  } catch {
    // Diagnostics must never replace the original failure or break its recovery path.
  }
}

export function reportErrorCause(source: string, cause: Cause.Cause<unknown>): boolean {
  for (const reason of cause.reasons) {
    if (reason._tag === "Fail") reportErrorDiagnostic(source, reason.error);
    else if (reason._tag === "Die") reportErrorDiagnostic(source, reason.defect);
  }
  return reporter !== undefined;
}
