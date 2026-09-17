import { createFileRoute, redirect } from "@tanstack/react-router";

// Preserve existing checkout links inside the shared settings layout.
export const Route = createFileRoute("/projects/$projectKey")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/settings/projects",
      search: { project: params.projectKey, machine: undefined, checkout: undefined },
      replace: true,
    });
  },
});
