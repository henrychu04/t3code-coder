import { createFileRoute } from "@tanstack/react-router";
import { ScopedProjectDefaults } from "../components/settings/ScopedProjectDefaults";
export const Route = createFileRoute("/settings/projects")({ component: ScopedProjectDefaults });
