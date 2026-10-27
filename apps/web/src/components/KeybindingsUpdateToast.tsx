import { subscribeAtomChanges } from "../rpc/atomRegistry";
import { primaryServerConfigEventAtom } from "../state/server";
import { createKeybindingsUpdateToastController } from "./KeybindingsUpdateToast.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

/** Toasts each keybindings reload the primary server reports. */
export function startKeybindingsUpdateToasts(): () => void {
  const controller = createKeybindingsUpdateToastController({});
  return subscribeAtomChanges(primaryServerConfigEventAtom, (event) => {
    const decision = controller.handle(event);
    if (!decision) return;

    if (decision._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Keybindings updated",
        description: "Keybindings configuration reloaded successfully.",
      });
      return;
    }

    // Coder: there are no local editors to open the config in, so the warning is its message.
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: decision.message,
      }),
    );
  });
}
