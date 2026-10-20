import { RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";

import { subscribeComposerDraftModelReconciliation } from "./composerDraftStore";
import { environmentThreadShells } from "./state/threads";
import { environmentShell } from "./state/shell";

import { appAtomRegistry, AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

export function AppRoot({ router }: { readonly router: AppRouter }) {
  useEffect(
    () =>
      subscribeComposerDraftModelReconciliation({
        registry: appAtomRegistry,
        threadShellAtom: environmentThreadShells.threadShellAtom,
        threadRefsAtom: environmentThreadShells.threadRefsAtom,
        shellStateAtom: environmentShell.stateAtom,
      }),
    [],
  );
  return (
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
    </AppAtomRegistryProvider>
  );
}
