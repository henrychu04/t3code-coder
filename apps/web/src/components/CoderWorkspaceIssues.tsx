import { CircleAlertIcon } from "lucide-react";

export interface CoderWorkspaceIssue {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly details: string;
}

export function summarizeCoderWorkspaceError(error: string): string {
  if (error.includes("requires nix-env")) {
    return "T3 Coder could not initialize this workspace because Nix is unavailable.";
  }
  if (error.startsWith("Coder workspace preflight")) {
    return "T3 Coder could not finish setting up this workspace.";
  }
  if (error.startsWith("Could not fetch workspace status")) {
    return "T3 Coder could not check the workspace status.";
  }
  const firstLine = error
    .split(/\r?\n/u)
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (firstLine === undefined) return "An unexpected workspace error occurred.";
  return firstLine.length > 180 ? `${firstLine.slice(0, 177)}…` : firstLine;
}

export function CoderWorkspaceIssueList({
  issues,
}: {
  readonly issues: readonly CoderWorkspaceIssue[];
}) {
  if (issues.length === 0) return null;
  return (
    <div
      aria-label="Workspace issues"
      className="mt-3 divide-y divide-destructive/20 rounded-lg border border-destructive/30 bg-destructive/5"
      role="alert"
    >
      {issues.map((issue) => (
        <div className="p-3" key={issue.id}>
          <div className="flex gap-2">
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-destructive-foreground">{issue.title}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{issue.summary}</p>
              {issue.details === issue.summary ? null : (
                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer select-none hover:text-foreground">
                    Technical details
                  </summary>
                  <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/70 p-2 font-mono text-[11px] leading-4 text-foreground/80">
                    {issue.details}
                  </pre>
                </details>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
