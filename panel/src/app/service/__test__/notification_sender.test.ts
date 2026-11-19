import http from "http";
import { AddressInfo } from "net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logged: string[] = [];
vi.mock("../log", () => {
  const push = (m: any) => logged.push(String(m));
  return { logger: { info: push, warn: push, error: push, debug: push } };
});

import { NotificationConfig } from "../../entity/notification_config";
import { buildEvent, signBody } from "../notification_payload";
import { classifyNetworkError, sendEvent } from "../notification_sender";

const SECRET = "s".repeat(64);
const WEBHOOK =
  "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKLmnopqrstuvwxyz0123";

interface Seen {
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  url: string;
}
let server: http.Server;
let seen: Seen[];
let respond: (res: http.ServerResponse) => void;
let port: number;

beforeEach(async () => {
  logged.length = 0;
  seen = [];
  respond = (res) => res.writeHead(204).end();
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks), url: req.url ?? "" });
      respond(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

function cfg(over: Partial<NotificationConfig> = {}) {
  const c = new NotificationConfig();
  c.enabled = true;
  c.url = `http://127.0.0.1:${port}/minefield`;
  c.secret = SECRET;
  c.allowPrivateAddress = true;
  return Object.assign(c, over);
}
const event = () =>
  buildEvent(
    { type: "instance.crashed", instance: { daemonId: "d", uuid: "u", name: "Survival" }, details: { exitCode: 1 } },
    { panelName: "Minefield Panel", id: "evt-1" }
  );

describe("sendEvent bot_http", () => {
  it("posts the signed raw body with the documented headers", async () => {
    const now = () => 1763467200_000;
    const r = await sendEvent(event(), cfg(), { now });
    expect(r).toMatchObject({ ok: true, status: 204 });
    const s = seen[0];
    expect(s.url).toBe("/minefield");
    expect(s.headers["content-type"]).toBe("application/json");
    expect(s.headers["user-agent"]).toBe("Minefield-Panel-Notifier/1");
    expect(s.headers["x-minefield-timestamp"]).toBe("1763467200");
    expect(s.headers["x-minefield-signature"]).toBe(signBody(SECRET, "1763467200", s.body));
    expect(JSON.parse(s.body.toString()).id).toBe("evt-1");
  });
  it("pins the validated address (second DNS answer is never used)", async () => {
    let calls = 0;
    const resolver = async () => (calls++ === 0 ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "203.0.113.9", family: 4 }]);
    const r = await sendEvent(event(), cfg({ url: `http://rebind.invalid:${port}/x` }), { resolver });
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].headers.host).toBe(`rebind.invalid:${port}`);
  });
  it("refuses private targets without the opt-in and makes no connection", async () => {
    const r = await sendEvent(event(), cfg({ allowPrivateAddress: false, url: `https://127.0.0.1:${port}/x` }));
    expect(r).toMatchObject({ ok: false, error: "blocked_address", retryable: false });
    expect(seen).toHaveLength(0);
  });
  it("does not follow redirects and reports a failure", async () => {
    respond = (res) => res.writeHead(302, { Location: `http://127.0.0.1:${port}/other` }).end();
    const r = await sendEvent(event(), cfg());
    expect(r).toMatchObject({ ok: false, error: "redirect", status: 302, retryable: false });
    expect(seen).toHaveLength(1);
  });
  it("classifies statuses: 5xx/408/429 retryable, other 4xx permanent", async () => {
    for (const [status, retryable, error] of [
      [500, true, "http_5xx"],
      [503, true, "http_5xx"],
      [408, true, "http_4xx"],
      [429, true, "http_4xx"],
      [400, false, "http_4xx"],
      [401, false, "http_4xx"],
      [413, false, "http_4xx"]
    ] as const) {
      respond = (res) => res.writeHead(status, { "Retry-After": "7" }).end();
      const r = await sendEvent(event(), cfg());
      expect(r).toMatchObject({ ok: false, status, retryable, error });
      if (status === 429) expect(r.retryAfterSec).toBe(7);
    }
  });
  it("times out", async () => {
    respond = () => {};
    const r = await sendEvent(event(), cfg(), { timeoutMs: 80 });
    expect(r).toMatchObject({ ok: false, error: "timeout", retryable: true });
  });
  it("caps the response read (a huge body does not hang the attempt)", async () => {
    respond = (res) => {
      res.writeHead(200);
      res.write("x".repeat(100_000));
      // never ends
    };
    const r = await sendEvent(event(), cfg(), { timeoutMs: 2000 });
    expect(r).toMatchObject({ ok: true, status: 200 });
  });
  it("reports connection errors as network", async () => {
    const s = http.createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const p = (s.address() as AddressInfo).port;
    await new Promise((r) => s.close(r));
    const r = await sendEvent(event(), cfg({ url: `http://127.0.0.1:${p}/` }));
    expect(r).toMatchObject({ ok: false, error: "network", retryable: true });
  });
  it("requires url and secret", async () => {
    expect(await sendEvent(event(), cfg({ secret: "" }))).toMatchObject({ error: "not_configured" });
    expect(await sendEvent(event(), cfg({ url: "" }))).toMatchObject({ error: "not_configured" });
  });
  it("never logs the url path, secret or body", async () => {
    respond = (res) => res.writeHead(500).end("leaky-response-body");
    await sendEvent(event(), cfg({ url: `http://127.0.0.1:${port}/very/secret/path?token=abc` }));
    const all = logged.join("\n");
    expect(all).toContain("code=http_5xx");
    for (const needle of ["secret/path", "token=abc", SECRET, "Survival", "leaky-response-body"])
      expect(all).not.toContain(needle);
  });
});

describe("sendEvent discord_webhook", () => {
  it("refuses a webhook url for a non-discord host without connecting", async () => {
    const r = await sendEvent(event(), cfg({ sinkType: "discord_webhook", url: `http://127.0.0.1:${port}/api/webhooks/1/2` }));
    expect(r).toMatchObject({ ok: false, error: "invalid_url" });
    expect(seen).toHaveLength(0);
  });
  it("blocks private resolution for the webhook even with allowPrivateAddress, without logging the url", async () => {
    const posted: any[] = [];
    const r = await sendEvent(
      event(),
      cfg({ sinkType: "discord_webhook", url: WEBHOOK, secret: "" }),
      { resolver: async () => [{ address: "127.0.0.1", family: 4 }] }
    );
    // 127.0.0.1 is blocked for webhooks regardless of allowPrivateAddress
    expect(r).toMatchObject({ ok: false, error: "blocked_address" });
    expect(posted).toHaveLength(0);
    expect(logged.join("\n")).not.toContain("abcDEF");
    expect(logged.join("\n")).not.toContain("/api/webhooks");
  });
});

describe("classifyNetworkError", () => {
  it("maps node error codes", () => {
    expect(classifyNetworkError({ code: "ENOTFOUND" })).toBe("dns");
    expect(classifyNetworkError({ code: "EAI_AGAIN" })).toBe("dns");
    expect(classifyNetworkError({ code: "ETIMEDOUT" })).toBe("timeout");
    expect(classifyNetworkError({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" })).toBe("tls");
    expect(classifyNetworkError({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).toBe("tls");
    expect(classifyNetworkError({ code: "ECONNREFUSED" })).toBe("network");
    expect(classifyNetworkError(new Error("x"))).toBe("network");
  });
});
