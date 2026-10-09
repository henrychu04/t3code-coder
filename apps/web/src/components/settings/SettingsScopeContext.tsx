import type { T3ProjectFile } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { createContext, type ReactNode, useContext, useMemo } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { resolveScopedSettingsTargets, selectScopedSettingsEnvironments } from "./scopedSettings";
import { selectSingleEnvironmentScope } from "./settingsScopeAxis";
import {
  resolveLegacyProjectSettingsSearch,
  resolveSettingsScope,
  type SettingsScopeSearch,
} from "./settingsScope";

/**
 * Each member's decoded t3.json, so file-backed settings show the file as a
 * layer in the inheritance chain. A member is only present once its read has
 * settled. The workspace helper reads the fixed file through the bounded
 * `projects.getConfig` RPC; the browser never reads the raw file.
 */
function useMemberProjectFiles(scope: ReturnType<typeof resolveSettingsScope>) {
  const members = scope.kind === "project" || scope.kind === "checkout" ? scope.members : [];
  return useAtomValue(
    useMemo(
      () =>
        Atom.make((get) => {
          const files = new Map<string, T3ProjectFile | null>();
          for (const member of members) {
            const result = get(
              projectEnvironment.getConfig({
                environmentId: member.environmentId,
                input: { projectId: member.id },
              }),
            );
            if (result.waiting && Option.isNone(AsyncResult.value(result))) continue;
            const config = Option.getOrNull(AsyncResult.value(result));
            files.set(member.physicalProjectKey, config?.status === "valid" ? config.file : null);
          }
          return files;
        }),
      [members],
    ),
  );
}

function useResolvedSettingsScope(rawSearch: SettingsScopeSearch, singleEnvironment: boolean) {
  const groups = useSettingsProjectGroups();
  const { environments: availableEnvironments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const resolvedSearch = useMemo(() => {
    const search = resolveLegacyProjectSettingsSearch(rawSearch, groups);
    return singleEnvironment
      ? selectSingleEnvironmentScope(
          search,
          resolveSettingsScope(search, groups, availableEnvironments),
          availableEnvironments,
          primaryEnvironmentId,
        )
      : search;
  }, [availableEnvironments, groups, primaryEnvironmentId, rawSearch, singleEnvironment]);
  const scope = useMemo(
    () => resolveSettingsScope(resolvedSearch, groups, availableEnvironments),
    [availableEnvironments, groups, resolvedSearch],
  );
  const projectFiles = useMemberProjectFiles(scope);
  return useMemo(() => {
    const selected = selectScopedSettingsEnvironments(
      scope,
      availableEnvironments,
      primaryEnvironmentId,
    );
    const targets = resolveScopedSettingsTargets(
      scope,
      selected.connectedEnvironments,
      projectFiles,
    );
    // The representative target supplies display values; project scopes
    // prefer the member on the primary environment, like environments do.
    const target =
      targets.find(
        (candidate) => candidate.environmentId === selected.environment?.environmentId,
      ) ??
      targets[0] ??
      null;
    return { scope, groups, ...selected, targets, target, search: resolvedSearch };
  }, [availableEnvironments, groups, primaryEnvironmentId, projectFiles, resolvedSearch, scope]);
}

const SettingsScopeContext = createContext<
  | (ReturnType<typeof useResolvedSettingsScope> & {
      singleEnvironment: boolean;
      search: SettingsScopeSearch;
      selectScope: (next: SettingsScopeSearch) => void;
    })
  | null
>(null);

export function SettingsScopeProvider({
  search,
  onChange,
  children,
  singleEnvironment = false,
}: {
  singleEnvironment?: boolean;
  search: SettingsScopeSearch;
  onChange: (next: SettingsScopeSearch) => void;
  children: ReactNode;
}) {
  const resolved = useResolvedSettingsScope(search, singleEnvironment);
  const value = useMemo(
    () => ({ ...resolved, singleEnvironment, selectScope: onChange }),
    [onChange, resolved, singleEnvironment],
  );
  return <SettingsScopeContext value={value}>{children}</SettingsScopeContext>;
}

export function useOptionalSettingsScope() {
  return useContext(SettingsScopeContext);
}

export function useSettingsScope() {
  const scope = useOptionalSettingsScope();
  if (scope === null) throw new Error("Settings scope must be read inside SettingsScopeProvider.");
  return scope;
}
