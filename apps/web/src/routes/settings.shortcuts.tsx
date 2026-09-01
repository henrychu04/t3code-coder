import { useAtomValue } from "@effect/atom-react";
import type {
  KeybindingCommand,
  KeybindingShortcut,
  ResolvedKeybindingRule,
} from "@t3tools/contracts";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  parseKeybindingWhenExpression,
} from "@t3tools/shared/keybindings";
import { createFileRoute } from "@tanstack/react-router";
import { PlusIcon, RotateCcwIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { KEYBINDING_ACTIONS } from "../keybindingCatalog";
import {
  DOUBLE_SHIFT_MAX_INTERVAL_MS,
  formatShortcutLabel,
  keybindingKeyForShortcut,
  keybindingWhenForNode,
} from "../keybindings";
import { isMacPlatform } from "../lib/utils";
import { keybindingWhenExpressionsOverlap } from "../keybindingOverlap";
import { SettingsPage, SettingsSection } from "../components/settings/SettingsPage";
import { KeybindingWhenEditor } from "../components/settings/KeybindingWhenEditor";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Kbd } from "../components/ui/kbd";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../state/server";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";

const CATEGORIES = ["Files", "Navigation", "Panels", "Chat", "Terminal", "Scripts"] as const;

function shortcutFromEvent(
  event: React.KeyboardEvent<HTMLButtonElement>,
): KeybindingShortcut | null {
  const key = event.key.toLowerCase();
  if (["shift", "control", "alt", "meta"].includes(key)) return null;
  const isMac = isMacPlatform(navigator.platform);
  return {
    key: key === "spacebar" ? " " : key,
    metaKey: isMac ? false : event.metaKey,
    ctrlKey: isMac ? event.ctrlKey : false,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    modKey: isMac ? event.metaKey : event.ctrlKey,
  };
}

function ruleInput(rule: ResolvedKeybindingRule) {
  const when = keybindingWhenForNode(rule.whenAst);
  return {
    key: keybindingKeyForShortcut(rule.shortcut),
    command: rule.command,
    ...(when ? { when } : {}),
  };
}

function sameRule(
  left: ResolvedKeybindingRule | null,
  right: ResolvedKeybindingRule | null,
): boolean {
  if (left === null || right === null) return left === right;
  return JSON.stringify(ruleInput(left)) === JSON.stringify(ruleInput(right));
}

function ShortcutsSettingsView() {
  const environmentId = usePrimaryEnvironmentId();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding);
  const removeKeybinding = useAtomCommand(serverEnvironment.removeKeybinding);
  const [query, setQuery] = useState("");
  const [capturing, setCapturing] = useState<{
    readonly command: KeybindingCommand;
    readonly replace: ResolvedKeybindingRule | null;
  } | null>(null);
  const [pending, setPending] = useState<{
    readonly command: KeybindingCommand;
    readonly replace: ResolvedKeybindingRule | null;
    readonly shortcut: KeybindingShortcut;
    readonly when: string;
  } | null>(null);
  const [busy, setBusy] = useState<KeybindingCommand | null>(null);
  const [error, setError] = useState<string | null>(null);
  const firstShiftAt = useRef<number | null>(null);

  const bindingsByCommand = useMemo(() => {
    const result = new Map<KeybindingCommand, ResolvedKeybindingRule[]>();
    for (const binding of keybindings) {
      const current = result.get(binding.command) ?? [];
      result.set(binding.command, [...current, binding]);
    }
    return result;
  }, [keybindings]);
  const defaultsByCommand = useMemo(() => {
    const result = new Map<KeybindingCommand, ResolvedKeybindingRule[]>();
    for (const binding of DEFAULT_RESOLVED_KEYBINDINGS) {
      const current = result.get(binding.command) ?? [];
      result.set(binding.command, [...current, binding]);
    }
    return result;
  }, []);

  const actions = useMemo(() => {
    const result = [...KEYBINDING_ACTIONS];
    const known = new Set(result.map((action) => action.command));
    for (const binding of keybindings) {
      if (known.has(binding.command) || !binding.command.startsWith("script.")) continue;
      const scriptId = binding.command.slice("script.".length, -".run".length);
      result.push({
        command: binding.command,
        label: `Run ${scriptId.replaceAll("-", " ")}`,
        category: "Scripts",
      });
      known.add(binding.command);
    }
    return result;
  }, [keybindings]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleActions = actions.filter(
    (action) =>
      normalizedQuery.length === 0 ||
      `${action.label} ${action.command}`.toLocaleLowerCase().includes(normalizedQuery),
  );

  const save = async (
    command: KeybindingCommand,
    shortcut: KeybindingShortcut,
    replace: ResolvedKeybindingRule | null,
    when: string,
  ) => {
    if (environmentId === null) return;
    const normalizedWhen = when.trim();
    if (normalizedWhen && !parseKeybindingWhenExpression(normalizedWhen)) {
      setError("Invalid when expression. Use variables with !, &&, ||, and parentheses.");
      return;
    }
    setBusy(command);
    setError(null);
    const result = await upsertKeybinding({
      environmentId,
      input: {
        key: keybindingKeyForShortcut(shortcut),
        command,
        ...(normalizedWhen ? { when: normalizedWhen } : {}),
        ...(replace ? { replace: ruleInput(replace) } : {}),
      },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      setError("Could not save that shortcut. Check the workspace connection and try again.");
      return;
    }
    setPending(null);
    setCapturing(null);
  };

  const remove = async (binding: ResolvedKeybindingRule) => {
    if (environmentId === null) return;
    setBusy(binding.command);
    setError(null);
    const result = await removeKeybinding({ environmentId, input: ruleInput(binding) });
    setBusy(null);
    if (result._tag === "Failure") {
      setError("Could not remove that shortcut. Check the workspace connection and try again.");
    }
  };

  const reset = async (command: KeybindingCommand) => {
    if (environmentId === null) return;
    setBusy(command);
    setError(null);
    const current = bindingsByCommand.get(command) ?? [];
    for (const binding of current) {
      const result = await removeKeybinding({ environmentId, input: ruleInput(binding) });
      if (result._tag === "Failure") {
        setError("Could not reset that shortcut. Check the workspace connection and try again.");
        setBusy(null);
        return;
      }
    }
    for (const defaultBinding of defaultsByCommand.get(command) ?? []) {
      const result = await upsertKeybinding({
        environmentId,
        input: {
          ...ruleInput(defaultBinding),
        },
      });
      if (result._tag === "Failure") {
        setError("Could not restore the default shortcut because it conflicts with another rule.");
        setBusy(null);
        return;
      }
    }
    setBusy(null);
    setPending(null);
    setCapturing(null);
  };

  return (
    <SettingsPage>
      <div className="space-y-2 px-3 sm:px-4">
        <h1 className="text-2xl font-semibold tracking-tight">Keyboard shortcuts</h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          IntelliJ-inspired defaults are stored in the active Coder workspace. Click a shortcut,
          then press the replacement. For Search project files, press Shift twice to assign the
          Search Everywhere gesture.
        </p>
        <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
          Some shortcuts are reserved by the browser and may not reach T3 Coder.
        </p>
        <div className="max-w-md pt-2">
          <Input
            aria-label="Search keyboard shortcuts"
            nativeInput
            placeholder="Search actions…"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        {environmentId === null ? (
          <p className="text-xs text-warning-foreground">Connect a workspace to edit shortcuts.</p>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>

      {CATEGORIES.map((category) => {
        const categoryActions = visibleActions.filter((action) => action.category === category);
        if (categoryActions.length === 0) return null;
        return (
          <SettingsSection key={category} title={category}>
            {categoryActions.map((action) => {
              const current = bindingsByCommand.get(action.command) ?? [];
              const candidate = pending?.command === action.command ? pending.shortcut : null;
              const candidateKey = candidate ? keybindingKeyForShortcut(candidate) : null;
              const contextRule = pending?.replace ?? defaultsByCommand.get(action.command)?.at(-1);
              const candidateWhen =
                pending?.when ?? keybindingWhenForNode(contextRule?.whenAst) ?? "";
              const conflict = candidateKey
                ? keybindings.find(
                    (binding) =>
                      binding.command !== action.command &&
                      keybindingKeyForShortcut(binding.shortcut) === candidateKey &&
                      keybindingWhenExpressionsOverlap(
                        keybindingWhenForNode(binding.whenAst),
                        candidateWhen,
                      ),
                  )
                : null;
              const conflictLabel = conflict
                ? (actions.find((candidateAction) => candidateAction.command === conflict.command)
                    ?.label ?? conflict.command)
                : null;
              const targets: ReadonlyArray<ResolvedKeybindingRule | null> =
                current.length > 0 ? current : [null];
              return (
                <div
                  key={action.command}
                  className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{action.label}</div>
                    <code className="text-[11px] text-muted-foreground">{action.command}</code>
                    {conflictLabel ? (
                      <p className="mt-1 text-xs text-warning-foreground">
                        Also assigned to {conflictLabel}; the later binding takes precedence.
                      </p>
                    ) : null}
                  </div>
                  <div className="flex min-w-0 items-center gap-2 sm:flex-[2]">
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      {targets.map((target, index) => {
                        const targetPending =
                          pending?.command === action.command && sameRule(pending.replace, target)
                            ? pending.shortcut
                            : null;
                        const isCapturing =
                          capturing?.command === action.command &&
                          sameRule(capturing.replace, target);
                        const pendingForTarget =
                          pending?.command === action.command && sameRule(pending.replace, target)
                            ? pending
                            : null;
                        const defaultRule = defaultsByCommand.get(action.command)?.at(-1);
                        const editableShortcut =
                          pendingForTarget?.shortcut ?? target?.shortcut ?? defaultRule?.shortcut;
                        const targetWhen =
                          pendingForTarget?.when ??
                          keybindingWhenForNode((target ?? defaultRule)?.whenAst) ??
                          "";
                        const isDefault =
                          target !== null &&
                          DEFAULT_RESOLVED_KEYBINDINGS.some((binding) => sameRule(binding, target));
                        return (
                          <div
                            key={target ? JSON.stringify(ruleInput(target)) : `unassigned:${index}`}
                            className="flex items-center gap-2"
                          >
                            <Button
                              type="button"
                              variant="outline"
                              className="w-28 shrink-0"
                              data-keybinding-capture=""
                              disabled={environmentId === null || busy !== null}
                              onClick={() => {
                                setPending(null);
                                setCapturing({ command: action.command, replace: target });
                                firstShiftAt.current = null;
                              }}
                              onBlur={() => {
                                firstShiftAt.current = null;
                                if (isCapturing) setCapturing(null);
                              }}
                              onKeyDown={(event) => {
                                if (!isCapturing) return;
                                event.preventDefault();
                                event.stopPropagation();
                                if (event.key === "Escape") {
                                  setCapturing(null);
                                  setPending(null);
                                  return;
                                }
                                if (event.key === "Shift") {
                                  const now = performance.now();
                                  if (
                                    firstShiftAt.current !== null &&
                                    now - firstShiftAt.current < DOUBLE_SHIFT_MAX_INTERVAL_MS
                                  ) {
                                    if (action.command !== "filePicker.toggle") {
                                      setError(
                                        "Shift Shift is currently supported only for Search project files.",
                                      );
                                      setCapturing(null);
                                      firstShiftAt.current = null;
                                      return;
                                    }
                                    const shortcut: KeybindingShortcut = {
                                      key: "double-shift",
                                      metaKey: false,
                                      ctrlKey: false,
                                      shiftKey: false,
                                      altKey: false,
                                      modKey: false,
                                    };
                                    setPending({
                                      command: action.command,
                                      replace: target,
                                      shortcut,
                                      when: targetWhen,
                                    });
                                    setCapturing(null);
                                    firstShiftAt.current = null;
                                  } else {
                                    firstShiftAt.current = now;
                                  }
                                  return;
                                }
                                firstShiftAt.current = null;
                                const shortcut = shortcutFromEvent(event);
                                if (!shortcut) return;
                                setPending({
                                  command: action.command,
                                  replace: target,
                                  shortcut,
                                  when: targetWhen,
                                });
                                setCapturing(null);
                              }}
                            >
                              {isCapturing ? (
                                "Press shortcut…"
                              ) : targetPending ? (
                                <Kbd>{formatShortcutLabel(targetPending)}</Kbd>
                              ) : target ? (
                                <Kbd>{formatShortcutLabel(target.shortcut)}</Kbd>
                              ) : (
                                "Unassigned"
                              )}
                            </Button>
                            <KeybindingWhenEditor
                              disabled={!editableShortcut || environmentId === null || busy !== null}
                              value={targetWhen}
                              onChange={(when) => {
                                if (!editableShortcut) return;
                                setPending({
                                  command: action.command,
                                  replace: target,
                                  shortcut: editableShortcut,
                                  when,
                                });
                              }}
                            />
                            <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                              {target ? (isDefault ? "Default" : "Custom") : "None"}
                            </span>
                            {target && !isDefault ? (
                              <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                className="shrink-0"
                                aria-label={`Remove ${action.label} binding`}
                                disabled={environmentId === null || busy !== null}
                                onClick={() => void remove(target)}
                              >
                                <Trash2Icon />
                              </Button>
                            ) : null}
                          </div>
                        );
                      })}
                      {candidate ? (
                        <div className="flex justify-end">
                          <Button
                            size="sm"
                            disabled={busy !== null}
                            onClick={() =>
                              void save(
                                action.command,
                                candidate,
                                pending?.replace ?? null,
                                pending?.when ?? candidateWhen,
                              )
                            }
                          >
                            Save
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {current.length > 0 ? (
                      <Button
                        type="button"
                        size="icon-sm"
                        variant="ghost"
                        className="shrink-0"
                        aria-label={`Add another ${action.label} binding`}
                        disabled={environmentId === null || busy !== null}
                        onClick={() => {
                          setPending(null);
                          setCapturing({ command: action.command, replace: null });
                          firstShiftAt.current = null;
                        }}
                      >
                        <PlusIcon />
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      className="shrink-0"
                      aria-label={`Reset ${action.label}`}
                      disabled={environmentId === null || busy !== null}
                      onClick={() => void reset(action.command)}
                    >
                      <RotateCcwIcon />
                    </Button>
                  </div>
                  </div>
                </div>
              );
            })}
          </SettingsSection>
        );
      })}

      {visibleActions.length === 0 ? (
        <div className="flex items-center gap-2 px-4 text-sm text-muted-foreground">
          <SearchIcon className="size-4" /> No matching actions.
        </div>
      ) : null}
    </SettingsPage>
  );
}

export const Route = createFileRoute("/settings/shortcuts")({
  component: ShortcutsSettingsView,
});
