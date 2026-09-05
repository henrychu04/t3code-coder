import { BookmarkIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import { type PromptStashEntry } from "../../promptStashStore";
import { ComposerBanner } from "./ComposerBanner";

const SNIPPET_MAX_CHARS = 90;

function stashEntrySnippet(entry: PromptStashEntry): string {
  const trimmed = entry.prompt.trim().replace(/\s+/g, " ");
  if (trimmed.length > 0) {
    return trimmed.length > SNIPPET_MAX_CHARS ? `${trimmed.slice(0, SNIPPET_MAX_CHARS)}…` : trimmed;
  }
  return "(empty)";
}

/**
 * Attached banner listing the stashed prompts. Keyboard-first: opened by the
 * stash shortcut on an empty composer, navigated with arrows, restored with
 * Enter, dismissed with Escape. The listener runs capture-phase on window so
 * it wins over the composer editor's handlers while the menu is open.
 */
export const ComposerStashMenu = memo(function ComposerStashMenu(props: {
  entries: ReadonlyArray<PromptStashEntry>;
  stashShortcutLabel: string | null;
  onRestore: (entry: PromptStashEntry) => void;
  onDelete: (entry: PromptStashEntry) => void;
  onClose: () => void;
}) {
  const { entries, stashShortcutLabel, onRestore, onDelete, onClose } = props;
  const drawerRef = useRef<HTMLDivElement>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(entries[0]?.id ?? null);

  const highlightedEntry = entries.find((entry) => entry.id === highlightedId) ?? entries[0];

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const drawer = drawerRef.current;
      if (
        (drawer && event.composedPath().includes(drawer)) ||
        (event.target instanceof Element &&
          event.target.closest('[data-prompt-stash-badge="true"]'))
      ) {
        return;
      }
      onClose();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [onClose]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (entries.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const currentIndex = entries.findIndex((entry) => entry.id === highlightedEntry?.id);
        const offset = event.key === "ArrowDown" ? 1 : -1;
        const normalizedIndex = currentIndex >= 0 ? currentIndex : offset === 1 ? -1 : 0;
        const nextIndex = (normalizedIndex + offset + entries.length) % entries.length;
        setHighlightedId(entries[nextIndex]?.id ?? null);
        const nextButton =
          drawerRef.current?.querySelectorAll<HTMLButtonElement>("[data-stash-restore]")[nextIndex];
        nextButton?.scrollIntoView({ block: "nearest" });
        if (drawerRef.current?.contains(document.activeElement)) {
          nextButton?.focus({ preventScroll: true });
        }
        return;
      }
      if (event.key === "Enter") {
        // A focused control inside the row (the delete button) owns its own
        // activation; swallowing Enter here would restore instead of delete.
        if (event.target instanceof HTMLElement && event.target.closest("button[aria-label]")) {
          return;
        }
        if (!highlightedEntry) return;
        event.preventDefault();
        event.stopPropagation();
        onRestore(highlightedEntry);
        return;
      }
      if (event.key === "Backspace" && (event.metaKey || event.ctrlKey)) {
        if (!highlightedEntry) return;
        event.preventDefault();
        event.stopPropagation();
        onDelete(highlightedEntry);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [entries, highlightedEntry, onClose, onDelete, onRestore]);

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root ref={drawerRef} data-composer-stash-drawer="true">
        <ComposerBanner.Row
          render={<button type="button" />}
          aria-label="Close stash"
          aria-expanded="true"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onClose}
        >
          <ComposerBanner.Icon>
            <BookmarkIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="text-muted-foreground">
            Stash · this session only
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.Count>{entries.length}</ComposerBanner.Count>
            <ComposerBanner.ToggleIcon expanded />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        <ComposerBanner.Scroll>
          <ComposerBanner.Children render={<ul role="list" />} aria-label="Stashed prompts">
            {entries.length === 0 ? (
              <ComposerBanner.Row render={<li />}>
                <ComposerBanner.Icon />
                <ComposerBanner.Content className="text-muted-foreground">
                  Nothing stashed yet.
                  {stashShortcutLabel
                    ? ` Press ${stashShortcutLabel} with a prompt in the composer to stash it.`
                    : null}
                </ComposerBanner.Content>
              </ComposerBanner.Row>
            ) : (
              entries.map((entry) => (
                <ComposerBanner.Row
                  render={<li />}
                  key={entry.id}
                  data-stash-entry={entry.id}
                  data-highlighted={highlightedEntry?.id === entry.id || undefined}
                  className={cn(
                    "relative rounded-sm",
                    highlightedEntry?.id === entry.id && "bg-accent text-accent-foreground",
                  )}
                  onMouseMove={() => {
                    if (highlightedId !== entry.id) setHighlightedId(entry.id);
                  }}
                  onFocus={() => setHighlightedId(entry.id)}
                >
                  <ComposerBanner.Icon>
                    <BookmarkIcon className="opacity-50" />
                  </ComposerBanner.Icon>
                  <ComposerBanner.Content>
                    <button
                      type="button"
                      className="min-w-0 flex-1 cursor-pointer truncate text-left text-foreground/80 outline-none before:absolute before:inset-0 before:rounded-sm focus-visible:before:ring-2 focus-visible:before:ring-ring"
                      data-stash-restore={entry.id}
                      aria-label={`Restore stashed prompt: ${stashEntrySnippet(entry)}`}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => onRestore(entry)}
                    >
                      {stashEntrySnippet(entry)}
                    </button>
                  </ComposerBanner.Content>
                  <ComposerBanner.Actions>
                    <time
                      dateTime={entry.createdAt}
                      className="shrink-0 text-muted-foreground tabular-nums max-sm:hidden"
                    >
                      {formatRelativeTimeLabel(entry.createdAt)}
                    </time>
                    <ComposerBanner.Dismiss
                      className="z-10"
                      aria-label="Delete stashed prompt"
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => onDelete(entry)}
                    />
                  </ComposerBanner.Actions>
                </ComposerBanner.Row>
              ))
            )}
          </ComposerBanner.Children>
        </ComposerBanner.Scroll>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});
