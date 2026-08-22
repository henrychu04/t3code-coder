import { createFileRoute, Link } from "@tanstack/react-router";

import { Button } from "../components/ui/button";

function CoderSettingsView() {
  const workspace = new URL(window.location.href).searchParams.get("workspace");

  return (
    <main className="min-h-dvh bg-background p-8 text-foreground">
      <div className="mx-auto max-w-2xl rounded-xl border border-border bg-card p-6 shadow-sm">
        <h1 className="text-xl font-semibold">Coder workspace</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {workspace ? `Connected to ${workspace}.` : "No Coder workspace is selected."}
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          Deployments and workspaces are configured from the Coder workspaces button. Authentication
          remains owned by the Coder CLI.
        </p>
        <Button className="mt-5" render={<Link to="/" search />}>
          Back to T3 Code
        </Button>
      </div>
    </main>
  );
}

export const Route = createFileRoute("/settings/general")({ component: CoderSettingsView });
