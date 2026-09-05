import { useState } from "react";

/** Clear a portaled menu when its measured, still-mounted trigger is hidden. */
export function useComposerMenuState(hidden = false) {
  const [open, setOpen] = useState(false);
  if (hidden && open) {
    setOpen(false);
  }
  return [open && !hidden, setOpen] as const;
}
