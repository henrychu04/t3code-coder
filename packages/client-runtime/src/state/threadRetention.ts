// Stream-backed atoms release their subscriptions as soon as their last view leaves.
// The browser retains settled snapshots separately in its bounded memory-only cache.
export const THREAD_STATE_IDLE_TTL_MS = 0;
