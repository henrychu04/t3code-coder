import { createFileRoute } from "@tanstack/react-router";
import { ProjectSettingsPage } from "../components/settings/ProjectSettingsPanel";

// The loopback Coder gateway owns access; no upstream pairing/authentication gate.
export const Route = createFileRoute("/projects/$projectKey")({
  component: () => <ProjectSettingsPage projectKey={Route.useParams().projectKey} />,
});
