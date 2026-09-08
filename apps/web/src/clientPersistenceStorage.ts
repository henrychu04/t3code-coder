import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  DiffLayout,
  type ClientSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";

// Read the fork's former name only at the persistence boundary. Writes use upstream's schema.
const PersistedClientSettingsSchema = Schema.Struct({
  ...ClientSettingsSchema.fields,
  diffLayout: Schema.optionalKey(DiffLayout),
  diffRenderMode: Schema.optionalKey(DiffLayout),
});

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  try {
    const persisted = getLocalStorageItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      PersistedClientSettingsSchema,
    );
    if (!persisted) return null;
    const { diffRenderMode, diffLayout, ...settings } = persisted;
    return {
      ...settings,
      diffLayout: diffLayout ?? diffRenderMode ?? DEFAULT_CLIENT_SETTINGS.diffLayout,
    };
  } catch (error) {
    console.error("Could not read persisted client settings.", error);
    return null;
  }
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
}
