import { createFileRoute } from "@tanstack/react-router";
// Shared layout retains the composer through draft promotion.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({ component: () => null });
