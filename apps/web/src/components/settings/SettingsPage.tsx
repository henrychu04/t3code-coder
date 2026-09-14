import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { useClearScopedSettings, useClearProjectOverrides } from "./useScopedSettings";
import {
  isProjectScopedSettingKey,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  listProjectOverrides,
} from "./scopedSettings";
import { SettingInheritance, type SettingOverridingProject } from "./SettingInheritance";
import { type ReactNode, useEffect } from "react";
import { Undo2Icon } from "lucide-react";
import { useLocation } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SettingsPage({ children }: { readonly children: ReactNode }) {
  const hash = useLocation({ select: (location) => location.hash });
  useEffect(() => {
    if (!hash) return;
    const target = document.getElementById(hash.replace(/^#/u, ""));
    target?.scrollIntoView({ block: "center" });
  }, [hash]);
  return (
    <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
      <WorkspacePageContainer className="gap-12">{children}</WorkspacePageContainer>
    </div>
  );
}

export function SettingsSection({
  children,
  description,
  id,
  title,
  unframed = false,
  headerAction,
}: {
  readonly children: ReactNode;
  readonly description?: string;
  readonly id?: string;
  readonly title: string;
  readonly unframed?: boolean;
  readonly headerAction?: ReactNode;
}) {
  return (
    <section className="space-y-3" id={id}>
      <div
        className={cn(
          "flex items-center justify-between gap-4 px-3 sm:px-4",
          unframed && "min-h-8",
        )}
      >
        <div>
          <h2
            className={cn(
              "text-lg font-semibold tracking-tight",
              unframed && "tracking-[-0.025em] text-foreground",
            )}
          >
            {title}
          </h2>
          {description ? (
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {headerAction}
      </div>
      <div
        className={
          unframed
            ? "relative space-y-1 overflow-visible text-foreground"
            : "divide-y divide-border/70 rounded-xl border bg-card/40"
        }
      >
        {children}
      </div>
    </section>
  );
}

function ScopedSettingsRow({
  children,
  className,
  control,
  description,
  id,
  resetAction,
  title,
  settingKeys = [],
}: {
  readonly settingKeys?: readonly (keyof ServerSettings)[];
  readonly children?: ReactNode;
  readonly className?: string;
  readonly control?: ReactNode;
  readonly description?: string;
  readonly id?: string;
  readonly resetAction?: ReactNode;
  readonly title: string;
}) {
  const context = useOptionalSettingsScope();
  const clear = useClearScopedSettings();
  const clearProjects = useClearProjectOverrides();
  const projectScope = context?.scope.kind === "project" || context?.scope.kind === "checkout";
  const scopedKeys = settingKeys.filter(isProjectScopedSettingKey);
  const mixed = context !== null && scopedSettingsAreMixed(context.targets, settingKeys);
  const source = context && projectScope ? scopedSettingsSource(context.targets, scopedKeys) : null;
  const unavailable = context !== null && settingKeys.length > 0 && context.targets.length === 0;
  const readOnly = projectScope && settingKeys.some((key) => !isProjectScopedSettingKey(key));
  const overridingProjects: SettingOverridingProject[] =
    context && !projectScope
      ? listProjectOverrides(context.connectedEnvironments, settingKeys).flatMap((entry) => {
          const group = context.groups.find((group) =>
            group.memberProjects.some(
              (member) =>
                member.environmentId === entry.environmentId && member.id === entry.projectId,
            ),
          );
          return group
            ? [
                {
                  ...entry,
                  label: group.displayName,
                  open: () =>
                    context.selectScope({
                      ...context.search,
                      project: group.projectKey,
                      checkout: undefined,
                    }),
                },
              ]
            : [];
        })
      : [];
  const customized = context?.targets.some((target) =>
    settingKeys.some((key) => !Equal.equals(target.settings[key], DEFAULT_SERVER_SETTINGS[key])),
  );
  const renderedReset =
    unavailable || readOnly ? null : projectScope && scopedKeys.length ? (
      source === "project" || source === "mixed" ? (
        <SettingResetButton label={title} inherit onClick={() => clear(scopedKeys)} />
      ) : null
    ) : (
      resetAction
    );
  const renderedInheritance =
    context && settingKeys.length > 0 ? (
      <SettingInheritance
        state={
          mixed
            ? "mixed"
            : source === "project"
              ? "overridden"
              : source === "environment"
                ? "inherited"
                : customized
                  ? "environment"
                  : "default"
        }
        summary={
          mixed
            ? "Mixed across selected workspaces"
            : source === "project"
              ? "Project override"
              : source === "environment"
                ? "Inherited from workspace"
                : customized
                  ? "Workspace setting"
                  : "Built-in default"
        }
        targets={context.targets}
        environments={context.connectedEnvironments}
        keys={settingKeys}
        overridingProjects={overridingProjects}
        onClearOverrides={(entries) => clearProjects(entries, scopedKeys)}
      />
    ) : null;
  return (
    <div
      id={id}
      className={cn(
        "flex flex-col gap-3 px-4 py-3 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] sm:items-center sm:gap-8",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex min-h-5 items-center gap-1.5">
          <h3 className="text-sm font-medium">{title}</h3>
          {renderedInheritance}
          {renderedReset}
          {mixed && <span className="text-xs font-medium text-warning">Mixed</span>}
        </div>
        {description ? (
          <p className="max-w-xl text-[13px] leading-[1.45] text-muted-foreground/80">
            {description}
          </p>
        ) : null}
        {readOnly || unavailable ? (
          <fieldset disabled inert className="opacity-50">
            {children}
          </fieldset>
        ) : (
          children
        )}
      </div>
      {control ? (
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <fieldset
            disabled={readOnly || unavailable}
            inert={readOnly || unavailable || undefined}
            className="flex items-center disabled:opacity-50"
          >
            {control}
          </fieldset>
          {readOnly ? (
            <span className="text-xs text-muted-foreground">Workspace-wide setting</span>
          ) : unavailable ? (
            <span className="text-xs text-muted-foreground">Connect the selected workspace</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function SettingResetButton(props: {
  readonly label: string;
  readonly inherit?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={`Reset ${props.label} to ${props.inherit ? "workspace value" : "default"}`}
            disabled={props.disabled ?? false}
            size="icon-micro"
            variant="ghost-muted"
            onClick={(event) => {
              event.stopPropagation();
              props.onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">
        {props.inherit ? "Inherit workspace value" : "Reset to default"}
      </TooltipPopup>
    </Tooltip>
  );
}

export function SettingsSelect({
  ariaLabel,
  children,
  onChange,
  value,
}: {
  readonly ariaLabel: string;
  readonly children: ReactNode;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      className="h-8 min-w-44 rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onChange={(event) => onChange(event.currentTarget.value)}
      value={value}
    >
      {children}
    </select>
  );
}

function UnscopedSettingsRow({
  children,
  className,
  control,
  description,
  id,
  resetAction,
  title,
}: {
  readonly children?: ReactNode;
  readonly className?: string;
  readonly control?: ReactNode;
  readonly description?: string;
  readonly id?: string;
  readonly resetAction?: ReactNode;
  readonly title: string;
}) {
  return (
    <div
      id={id}
      className={cn(
        "flex flex-col gap-3 px-4 py-3 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] sm:items-center sm:gap-8",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex min-h-5 items-center gap-1.5">
          <h3 className="text-sm font-medium">{title}</h3>
          {resetAction}
        </div>
        {description ? (
          <p className="max-w-xl text-[13px] leading-[1.45] text-muted-foreground/80">
            {description}
          </p>
        ) : null}
        {children}
      </div>
      {control ? <div className="flex items-center sm:justify-end">{control}</div> : null}
    </div>
  );
}

export function SettingsRow(props: Parameters<typeof ScopedSettingsRow>[0]) {
  const context = useOptionalSettingsScope();
  return context ? <ScopedSettingsRow {...props} /> : <UnscopedSettingsRow {...props} />;
}
