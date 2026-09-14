import { Fragment, type ReactNode } from "react";
import type { EnvironmentPresentation } from "../../state/environments";
import { useSettingsScope } from "./SettingsScopeContext";
export function ScopedSettingsTarget({
  children,
}: {
  children: (environment: EnvironmentPresentation) => ReactNode;
}) {
  const { environment, scope, target, search } = useSettingsScope();
  return environment && target && scope.kind !== "unavailable" ? (
    <Fragment key={JSON.stringify(search)}>{children(environment)}</Fragment>
  ) : (
    <p role="status" className="px-4 py-6 text-sm text-muted-foreground">
      {scope.kind === "unavailable"
        ? scope.message
        : "Connect a selected Coder workspace to edit its settings."}
    </p>
  );
}
