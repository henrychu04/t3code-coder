import {
  createContext,
  useContext,
  useMemo,
  useCallback,
  type ReactNode,
  type ComponentPropsWithoutRef,
} from "react";
declare module "@tanstack/react-router" {
  interface HistoryState {
    settingsTargetHighlight?: boolean;
  }
}

interface SettingsSearchTargetContextValue {
  readonly targetId: string | null;
  readonly highlightTarget: boolean;
  readonly onTargetHandled: () => void;
}

const noop = () => undefined;
const SettingsSearchTargetContext = createContext<SettingsSearchTargetContextValue>({
  targetId: null,
  highlightTarget: true,
  onTargetHandled: noop,
});

export function SettingsSearchTargetProvider({
  targetId,
  highlightTarget = true,
  onTargetHandled = noop,
  children,
}: {
  targetId: string | null;
  highlightTarget?: boolean;
  onTargetHandled?: () => void;
  children: ReactNode;
}) {
  const value = useMemo(
    () => ({ targetId, highlightTarget, onTargetHandled }),
    [highlightTarget, onTargetHandled, targetId],
  );
  return <SettingsSearchTargetContext value={value}>{children}</SettingsSearchTargetContext>;
}

function scrollAndFocusSettingsTarget(target: HTMLElement, highlight = true): void {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const markedScrollTarget =
    typeof target.querySelector === "function"
      ? target.querySelector<HTMLElement>(":scope > [data-settings-scroll-target]")
      : null;
  const scrollTarget =
    markedScrollTarget ??
    (target.tagName === "SECTION" && target.firstElementChild
      ? (target.firstElementChild as HTMLElement)
      : target);

  scrollTarget.scrollIntoView({
    behavior: prefersReducedMotion ? "auto" : "smooth",
    block: "center",
  });
  if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
  target.focus({ preventScroll: true });
  target.classList.remove("settings-search-target-pulse");
  if (!highlight || prefersReducedMotion) return;
  void target.offsetWidth;
  target.classList.add("settings-search-target-pulse");
  // The class also suppresses the focus outline (the pulse is the destination
  // indicator), so drop it once the element is no longer the destination.
  target.addEventListener("blur", () => target.classList.remove("settings-search-target-pulse"), {
    once: true,
  });
}

/** The row id a settings-search jump is currently trying to reach, if any. */
export function useSettingsSearchTargetId(): string | null {
  return useContext(SettingsSearchTargetContext).targetId;
}

export function useSettingsSearchTarget<T extends HTMLElement>(id: string | undefined) {
  const { targetId, highlightTarget, onTargetHandled } = useContext(SettingsSearchTargetContext);
  const isSearchTarget = id !== undefined && id === targetId;
  const targetRef = useCallback(
    (target: T | null) => {
      if (target && isSearchTarget) {
        scrollAndFocusSettingsTarget(target, highlightTarget);
        onTargetHandled();
      }
    },
    [highlightTarget, isSearchTarget, onTargetHandled],
  );

  return targetRef;
}

export function SettingsSearchTarget({
  children,
  ...targetProps
}: ComponentPropsWithoutRef<"div">) {
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(targetProps.id);
  return (
    <div {...targetProps} ref={targetRef} tabIndex={targetProps.id ? -1 : targetProps.tabIndex}>
      {children}
    </div>
  );
}

export function scrollToSettingsTarget(
  targetId: string,
  { highlight = true }: { readonly highlight?: boolean } = {},
): boolean {
  const target = document.getElementById(targetId);
  if (!target) return false;
  scrollAndFocusSettingsTarget(target, highlight);
  return true;
}
