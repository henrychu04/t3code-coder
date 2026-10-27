import { deadlineAfter } from "@t3tools/client-runtime/clock";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { useDeadlinePassed } from "./useDeadline";

// Coder: there is no "Disconnect server" action, so upstream's `useEnvironmentDisconnectDelay`
// is not carried; the composer's reconnect grace uses the hold below.

/**
 * Whether `environmentId` has stayed the same non-null value for `delayMs`. Every change starts a
 * new delay, so leaving and returning to an id restarts it.
 */
export function useEnvironmentStateHeldFor(environmentId: EnvironmentId | null, delayMs: number) {
  const [held, setHeld] = useState(() => ({
    environmentId,
    deadline: deadlineAfter(delayMs),
  }));
  if (held.environmentId !== environmentId) {
    setHeld({ environmentId, deadline: deadlineAfter(delayMs) });
  }
  const elapsed = useDeadlinePassed(held.environmentId === null ? null : held.deadline);
  return environmentId !== null && held.environmentId === environmentId && elapsed;
}
