import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";
import { ProviderUsageLimits } from "../settings/ProviderUsageLimits";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** Show the workspace snapshot without running the agent or probing an account. */
export function usageLimitsBannerItem(
  id: string,
  limits: ServerProviderUsageLimits,
  onDismiss: () => void,
): ComposerBannerStackItem {
  return {
    id,
    variant: "info",
    priority: "notice",
    icon: <GaugeIcon />,
    title: "Usage limits",
    dismissLabel: "Dismiss usage limits",
    onDismiss,
    children: (
      <ComposerBanner.Scroll>
        <ProviderUsageLimits limits={limits} />
      </ComposerBanner.Scroll>
    ),
  };
}
