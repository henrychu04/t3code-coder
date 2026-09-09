import { describe, expect, it } from "vite-plus/test";
import { Cookies, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

describe("Effect HTTP response compatibility", () => {
  it("can inspect a rejected response when Headers has no getSetCookie", () => {
    const response = new Response("Request rejected", { status: 400 });
    Object.defineProperty(response.headers, "getSetCookie", { value: undefined });
    const result = HttpClientResponse.fromWeb(
      HttpClientRequest.post("https://example.test/request"),
      response,
    );
    expect(result.cookies).toEqual(Cookies.empty);
    expect(result.status).toBe(400);
  });

  it("preserves cookies on platforms that expose Set-Cookie headers", () => {
    const result = HttpClientResponse.fromWeb(
      HttpClientRequest.get("https://example.test"),
      new Response(null, { headers: { "Set-Cookie": "session=abc; HttpOnly" } }),
    );
    expect(result.cookies).toEqual(Cookies.fromSetCookie(["session=abc; HttpOnly"]));
  });
});
