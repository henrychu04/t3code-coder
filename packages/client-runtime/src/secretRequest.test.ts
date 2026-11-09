import { SecretRequestError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestLink,
  secretRequestPrivacyNote,
} from "./secretRequest.ts";

describe("secretRequestDisplay", () => {
  it("never offers the form for a request inherited from another thread", () => {
    expect(secretRequestDisplay({ secretStatus: "pending" }, "inherited")).toEqual({
      kind: "pending-elsewhere",
      label: "Waiting for an answer in the original thread",
    });
    expect(secretRequestDisplay({ secretStatus: "saved" }, "inherited")).toMatchObject({
      outcome: "saved",
    });
  });
});

describe("secretRequestPrivacyNote", () => {
  it("does not promise to hide a value that the agent's commands can read", () => {
    expect(secretRequestPrivacyNote({})).toBe("Stored securely, never shown to the agent");
    expect(secretRequestPrivacyNote({ delivery: "file" })).not.toContain("never shown");
  });
});

describe("secretRequestLink", () => {
  it.each([
    [
      "Open this link and sign in: https://a.dev/x?s=1. Then paste the code.",
      "https://a.dev/x?s=1",
    ],
    ["Open [https://a.dev/x?s=1](https://a.dev/x?s=1) and sign in.", "https://a.dev/x?s=1"],
    ["Sign in [here](https://a.dev/login?state=abc(def)).", "https://a.dev/login?state=abc(def)"],
    ["Sign in at https://a.dev/login?state=abc(def).", "https://a.dev/login?state=abc(def)"],
    ["(Sign in at https://a.dev/login.)", "https://a.dev/login"],
    ["Open **https://a.dev/x?s=1** and sign in.", "https://a.dev/x?s=1"],
    ["Open https://a.dev/x?state=u7o_ and sign in.", "https://a.dev/x?state=u7o_"],
    ["**Sign in at https://a.dev/device**", "https://a.dev/device"],
    ["_Open https://a.dev/device_.", "https://a.dev/device"],
    ["_https://a.dev/x?state=u7o_&client_id=cli_", "https://a.dev/x?state=u7o_&client_id=cli"],
    ["Use client_id acme at https://a.dev/x?state=u7o_", "https://a.dev/x?state=u7o_"],
    ["_Sign in_ at https://a.dev/x?state=u7o_", "https://a.dev/x?state=u7o_"],
    ["_Required_: Open https://a.dev/x?state=u7o_", "https://a.dev/x?state=u7o_"],
    ["(**https://a.dev/login**)", "https://a.dev/login"],
    ["Open ***https://a.dev/device***", "https://a.dev/device"],
    ["Open **_https://a.dev/device_**", "https://a.dev/device"],
    [
      "Open [https://a.dev/x?s=u7o_](https://a.dev/x?s=u7o_) and sign in.",
      "https://a.dev/x?s=u7o_",
    ],
    ["Open `https://a.dev/x?s=1.` and sign in.", "https://a.dev/x?s=1."],
    ["Open https://a.dev/x?s=1, then if needed https://a.dev/x?s=1 again.", "https://a.dev/x?s=1"],
    ["Open https://a.dev or https://b.dev.", undefined],
    ["Open https://a.dev (also written https://a.dev/).", "https://a.dev/"],
    ["Paste the code the CLI printed.", undefined],
  ])("finds the one link in a reason: %s", (reason, href) => {
    expect(secretRequestLink({ reason })?.href).toBe(href);
  });

  it("prefers the agent's url over a link in the reason", () => {
    expect(
      secretRequestLink({ url: "https://auth.acme.dev/a", reason: "See https://docs.acme.dev" })
        ?.host,
    ).toBe("auth.acme.dev");
  });
});

describe("secretRequestFailureMessage", () => {
  it("passes through server errors but hides anything that could echo the payload", () => {
    expect(
      secretRequestFailureMessage(new SecretRequestError({ reason: "already_answered" })),
    ).toBe("This secret request was already answered.");
    expect(secretRequestFailureMessage(new Error('Expected string, got "whsec_1"'))).toBe(
      "Could not answer the request. Try again.",
    );
    expect(secretRequestFailureMessage(undefined)).toBe("Could not answer the request. Try again.");
  });
});
