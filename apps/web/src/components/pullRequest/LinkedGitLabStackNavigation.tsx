import type { ScopedThreadRef } from "@t3tools/contracts";
import { CheckIcon, LayersIcon } from "lucide-react";
import { useThreadShell } from "~/state/entities";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { Button } from "../ui/button";
import { Menu, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { linkedGitLabStack } from "./linkedGitLabStack";
import { PullRequestStateGlyph } from "./pullRequestPresentation";

export function LinkedGitLabStackNavigation({
  threadRef,
  currentUrl,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly currentUrl: string;
}) {
  const thread = useThreadShell(threadRef);
  const open = useOpenPrLink(threadRef);
  const stack = linkedGitLabStack(thread?.pullRequests ?? [], currentUrl);
  if (!stack) return null;
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="xs" variant="ghost" />}
        aria-label={`MR stack: layer ${stack.position} of ${stack.layers.length}`}
      >
        <LayersIcon aria-hidden className="size-3.5" />
        {stack.position}/{stack.layers.length}
      </MenuTrigger>
      <MenuPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <MenuGroupLabel>Linked MR stack · {stack.layers.length} layers</MenuGroupLabel>
        <MenuGroupLabel>Inferred from linked branch relationships</MenuGroupLabel>
        {stack.layers.toReversed().map((link, index) => {
          const selected = stack.layers.length - index === stack.position;
          return (
            <MenuItem
              key={link.number}
              aria-current={selected ? "page" : undefined}
              onClick={(event) => open(event, link.url)}
            >
              {link.snapshot ? (
                <PullRequestStateGlyph
                  state={link.snapshot.state}
                  isDraft={link.snapshot.isDraft}
                />
              ) : (
                <LayersIcon aria-hidden className="size-3.5" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  !{link.number} {link.snapshot?.title ?? link.repository}
                </span>
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {link.snapshot
                    ? `${link.snapshot.headBranch} → ${link.snapshot.baseBranch}`
                    : "Waiting for GitLab status"}
                </span>
              </span>
              {selected ? <CheckIcon aria-hidden className="size-3.5" /> : null}
            </MenuItem>
          );
        })}
        <MenuGroupLabel>Base: {stack.layers[0]?.snapshot?.baseBranch ?? "unknown"}</MenuGroupLabel>
      </MenuPopup>
    </Menu>
  );
}
