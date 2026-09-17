import type { ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { useSettingsScope } from "./SettingsScopeContext";
import { useEnvironments } from "../../state/environments";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import {
  getSettingsSearchTargetScope,
  getThreadAutoSettlementSearchAvailability,
  isSettingsSearchScopeAvailable,
} from "./settingsSearch";
const DEVICE_ONLY_PATHS = new Set([
  "/settings/appearance",
  "/settings/general",
  "/settings/open-source-licenses",
]);
export function SettingsScopeBoundary({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}) {
  const { scope, connectedEnvironments } = useSettingsScope();
  const { environments } = useEnvironments();
  const hash = useLocation({ select: (location) => location.hash });
  const searchTarget = getSettingsSearchTargetScope(hash.replace(/^#/, ""));
  const autoSettlementAvailability = searchTarget?.requiresThreadAutoSettlement
    ? getThreadAutoSettlementSearchAvailability(environments, scope)
    : null;
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    autoSettlementAvailability &&
    !autoSettlementAvailability.isTargetAvailable
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        targetId={hash}
        eligibleEnvironmentIds={autoSettlementAvailability.eligibleEnvironmentIds}
      >
        {autoSettlementAvailability.eligibleEnvironmentIds.length > 0
          ? `${searchTarget.title} requires a supporting environment. Choose one to continue.`
          : `${searchTarget.title} requires a supporting environment. Connect or update an environment to continue.`}
      </SettingsScopeNotice>
    );
  }
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    !isSettingsSearchScopeAvailable(searchTarget.scope, scope.kind)
  ) {
    const target =
      searchTarget.scope === "environment" ||
      searchTarget.scope === "project" ||
      searchTarget.scope === "checkout"
        ? searchTarget.scope
        : "all";
    return (
      <SettingsScopeNotice target={target} targetId={hash}>
        {`${searchTarget.title} is not available for the selected target. Choose its owning scope to continue.`}
      </SettingsScopeNotice>
    );
  }
  // Device-local pages ignore the scope entirely; the project page follows
  // remembered members while a grouping change replaces its URL key.
  if (DEVICE_ONLY_PATHS.has(pathname) || pathname === "/settings/projects") {
    return children;
  }
  // The breadcrumb already explains the unavailable selection. Keep its controls
  // visible for recovery without repeating the same notice in the page body.
  if (scope.kind === "unavailable") return null;
  if (scope.kind === "environment" && connectedEnvironments.length === 0) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        Reconnect {scope.label} to change its settings.
      </p>
    );
  }
  return children;
}
