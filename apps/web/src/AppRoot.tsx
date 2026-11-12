import { RouterProvider } from "@tanstack/react-router";

import { I18nProvider } from "./i18n/I18nProvider";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";

export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <I18nProvider>
      <AppAtomRegistryProvider>
        <RouterProvider router={router} />
      </AppAtomRegistryProvider>
    </I18nProvider>
  );
}
