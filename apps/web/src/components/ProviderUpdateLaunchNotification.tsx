import { ProviderUpdatePrimaryNotification } from "./ProviderUpdatePrimaryNotification";

/**
 * The provider update popover.
 *
 * Coder: upstream splits the prompt per environment only when a desktop-local WSL backend runs
 * beside the primary. Coder has no local backends, so it always uses the single-prompt flow for
 * the active workspace.
 */
export function ProviderUpdateLaunchNotification() {
  return <ProviderUpdatePrimaryNotification />;
}
