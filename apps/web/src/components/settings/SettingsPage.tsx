import {
  scrollToSettingsTarget,
  SettingsSearchTargetProvider,
  useSettingsSearchTarget,
} from "./settingsSearchTarget";
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
import { type ReactNode, useEffect, useCallback, useRef } from "react";
import { Undo2Icon } from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SettingsPage({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string | undefined;
}) {
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const highlightTarget = useLocation({
    select: (location) => location.state.settingsTargetHighlight !== false,
  });
  const targetId = hash.replace(/^#/, "") || null;
  const handledTarget = useRef<string | null>(null);
  const clearTargetHash = useCallback(() => {
    if (handledTarget.current === targetId) return;
    handledTarget.current = targetId;
    void navigate({
      hash: "",
      replace: true,
      resetScroll: false,
      hashScrollIntoView: false,
      state: { settingsTargetHighlight: true },
    });
  }, [navigate, targetId]);
  // Also reach static anchors outside a SettingsRow, including the header's restore button.
  useEffect(() => {
    if (!targetId) handledTarget.current = null;
    if (
      targetId &&
      handledTarget.current !== targetId &&
      scrollToSettingsTarget(targetId, { highlight: highlightTarget })
    )
      clearTargetHash();
  }, [targetId, highlightTarget, clearTargetHash]);
  return (
    <SettingsSearchTargetProvider
      targetId={targetId}
      highlightTarget={highlightTarget}
      onTargetHandled={clearTargetHash}
    >
      <div
        data-settings-page-scroll
        className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto"
      >
        <WorkspacePageContainer className={cn("gap-8", className)}>
          {children}
        </WorkspacePageContainer>
      </div>
    </SettingsSearchTargetProvider>
  );
}

export function SettingsSection({
  children,
  description,
  id,
  title,
  unframed = false,
  headerAction,
  hideTitle = false,
}: {
  readonly children: ReactNode;
  readonly description?: string;
  readonly id?: string | undefined;
  readonly title: string;
  readonly unframed?: boolean;
  readonly headerAction?: ReactNode;
  readonly hideTitle?: boolean;
}) {
  const targetRef = useSettingsSearchTarget<HTMLElement>(id);
  return (
    <section
      ref={targetRef}
      tabIndex={id ? -1 : undefined}
      className={cn(!hideTitle && "space-y-2.5")}
      id={id}
    >
      <div
        data-settings-scroll-target
        className={cn(
          hideTitle && "sr-only",
          "flex min-h-7 items-start justify-between gap-4 px-3 sm:px-4",
          unframed && "min-h-8",
        )}
      >
        <div>
          <h2
            className={cn(
              "flex min-h-7 items-center text-sm font-normal tracking-[-0.005em] text-foreground/70",
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
            : "relative overflow-visible rounded-xl border border-border/60 bg-card/40 shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none"
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
  status,
  title,
  settingKeys = [],
}: {
  readonly settingKeys?: readonly (keyof ServerSettings)[];
  readonly children?: ReactNode;
  readonly className?: string | undefined;
  readonly control?: ReactNode;
  readonly description?: ReactNode;
  readonly id?: string | undefined;
  readonly resetAction?: ReactNode;
  readonly status?: ReactNode;
  readonly title: ReactNode;
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
        <SettingResetButton
          label={typeof title === "string" ? title : "setting"}
          inherit
          onClick={() => clear(scopedKeys)}
        />
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
    <SettingsRowLayout
      id={id}
      className={className}
      title={title}
      description={description}
      status={status}
      inheritance={renderedInheritance}
      resetAction={renderedReset}
      mixed={mixed}
      control={
        control ? (
          <div className="flex w-full flex-col items-start gap-1 sm:w-auto sm:items-end">
            <fieldset
              disabled={readOnly || unavailable}
              inert={readOnly || unavailable || undefined}
              className="flex w-full items-center gap-2 disabled:opacity-50 sm:w-auto"
            >
              {control}
            </fieldset>
            {readOnly ? (
              <span className="text-xs text-muted-foreground">Workspace-wide setting</span>
            ) : unavailable ? (
              <span className="text-xs text-muted-foreground">Connect the selected workspace</span>
            ) : null}
          </div>
        ) : null
      }
    >
      {children && (readOnly || unavailable) ? (
        <fieldset disabled inert className="opacity-50">
          {children}
        </fieldset>
      ) : (
        children
      )}
    </SettingsRowLayout>
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
  id,
  disabled,
  className,
  onChange,
  value,
}: {
  readonly ariaLabel: string;
  readonly children: ReactNode;
  readonly id?: string | undefined;
  readonly disabled?: boolean;
  readonly className?: string | undefined;
  readonly onChange: (value: string) => void;
  readonly value: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      id={id}
      disabled={disabled}
      className={cn(
        "h-8 min-w-44 rounded-md border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64",
        className,
      )}
      onChange={(event) => onChange(event.currentTarget.value)}
      value={value}
    >
      {children}
    </select>
  );
}

/** Shared presentation for server settings, browser preferences, and fork resource rows. */
function SettingsRowLayout({
  children,
  className,
  control,
  description,
  id,
  resetAction,
  status,
  title,
  inheritance,
  mixed,
}: Parameters<typeof ScopedSettingsRow>[0] & {
  inheritance?: ReactNode;
  mixed?: boolean;
}) {
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(id);
  return (
    <div
      id={id}
      ref={targetRef}
      tabIndex={id ? -1 : undefined}
      data-slot="settings-row"
      className={cn("rounded-xl px-3 sm:px-4", children ? "pt-3 pb-1" : "py-3", className)}
    >
      <div className="flex flex-col gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] sm:items-center sm:gap-8">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="min-w-0 text-sm font-medium tracking-[-0.005em] text-foreground">
              {title}
            </h3>
            {inheritance ? (
              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
                {inheritance}
              </span>
            ) : null}
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
            {mixed ? <span className="text-xs font-medium text-warning">Mixed</span> : null}
          </div>
          {description ? (
            <p className="max-w-xl break-words text-[13px] leading-[1.45] text-muted-foreground/80">
              {description}
            </p>
          ) : null}
          {status ? <div className="pt-0.5 text-xs text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function SettingsRow(props: Parameters<typeof ScopedSettingsRow>[0]) {
  const context = useOptionalSettingsScope();
  return context ? <ScopedSettingsRow {...props} /> : <SettingsRowLayout {...props} />;
}
