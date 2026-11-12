// Coder: the browser-only local API. Upstream's desktop IPC contract (`contracts/ipc.ts`) is not
// carried, so its context-menu and confirm-dialog types live here.
import type { ClientSettings } from "@t3tools/contracts/settings";

export interface ContextMenuItem<T extends string = string> {
  readonly id: T;
  readonly label: string;
  readonly detail?: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly header?: boolean;
  readonly icon?: string;
  readonly separatorBefore?: boolean;
  readonly children?: readonly ContextMenuItem<T>[];
}

export type ConfirmDialogVariant = "default" | "destructive";
export interface ConfirmDialogOptions {
  readonly variant?: ConfirmDialogVariant;
  /** Which button takes focus on open. Defaults to Cancel; destructive confirms always keep Cancel. */
  readonly initialFocus?: "confirm" | "cancel";
}

export interface LocalApi {
  readonly shell: {
    readonly openExternal: (url: string) => Promise<void>;
  };
  readonly dialogs: {
    readonly confirm: (message: string, options?: ConfirmDialogOptions) => Promise<boolean>;
  };
  readonly contextMenu: {
    readonly show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { readonly x: number; readonly y: number },
    ) => Promise<T | null>;
    readonly close: () => Promise<void>;
  };
  readonly persistence: {
    readonly getClientSettings: () => Promise<ClientSettings | null>;
    readonly setClientSettings: (settings: ClientSettings) => Promise<void>;
  };
}
