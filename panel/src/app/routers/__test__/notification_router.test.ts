import http from "http";
import Koa from "koa";
import { koaBody } from "koa-body";
import Router from "@koa/router";
import { AddressInfo } from "net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Fake permission middleware: role comes from the x-test-role header; the route's declared
// level must be satisfied. This verifies each route declares ADMIN.
vi.mock("../../middleware/permission", () => ({
  default: (cfg: { level: number }) => async (ctx: any, next: Function) => {
    const role = ctx.get("x-test-role");
    if (role === "" || Number(role) < cfg.level) {
      ctx.status = 403;
      ctx.body = "Insufficient Permissions";
      return;
    }
    return await next();
  }
}));
vi.mock("../../middleware/limit", () => ({
  speedLimit: () => async (_ctx: any, next: Function) => await next()
}));
vi.mock("../../service/log", () => {
  const n = () => {};
  return { logger: { info: n, warn: n, error: n, debug: n } };
});
const opLog = vi.fn();
vi.mock("../../service/operation_logger", () => ({
  operationLogger: { log: (...a: any[]) => opLog(...a) },
  getOperationLoggerOperator: () => ({ operator_ip: "1.1.1.1", operator_name: "admin" })
}));
const store = new Map<string, any>();
vi.mock("../../common/storage/sys_storage", () => ({
  default: {
    getStorage: () => ({
      store: async (c: string, id: string, o: any) => void store.set(`${c}/${id}`, JSON.parse(JSON.stringify(o))),
      load: async (c: string, K: any, id: string) => {
        const v = store.get(`${c}/${id}`);
        return v ? Object.assign(new K(), v) : null;
      },
      list: async () => [],
      delete: async () => {}
    })
  }
}));
const sendEvent = vi.fn();
vi.mock("../../service/notification_sender", () => ({
  sendEvent: (...a: any[]) => sendEvent(...a),
  classifyNetworkError: () => "network"
}));

import { MASKED_SECRET, NotificationConfig } from "../../entity/notification_config";
import { setNotificationConfigForTest } from "../../service/notification_config_service";
import notificationService from "../../service/notification_service";
import router from "../notification_router";

let server: http.Server;
let base: string;

async function call(method: string, path: string, body?: any, role: string | null = "10") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (role !== null) headers["x-test-role"] = role;
  const res = await fetch(base + "/api" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, text };
}

beforeAll(async () => {
  const app = new Koa();
  app.use(koaBody());
  const api = new Router({ prefix: "/api" });
  api.use(router.routes()).use(router.allowedMethods());
  app.use(api.routes());
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  notificationService.reset();
});
beforeEach(() => {
  store.clear();
  opLog.mockClear();
  sendEvent.mockReset();
  notificationService.reset();
  setNotificationConfigForTest(new NotificationConfig());
});

const ROUTES: [string, string][] = [
  ["GET", "/notification/config"],
  ["PUT", "/notification/config"],
  ["POST", "/notification/secret/rotate"],
  ["POST", "/notification/test"]
];

describe("access control", () => {
  it.each(ROUTES)("%s %s refuses anonymous and regular users", async (method, path) => {
    for (const role of [null, "0", "1"]) {
      const r = await call(method, path, method === "GET" ? undefined : {}, role);
      expect(r.status).toBe(403);
    }
    expect(store.size).toBe(0);
    expect(opLog).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
  });
});

describe("GET /config", () => {
  it("returns defaults and status for an admin", async () => {
    const r = await call("GET", "/notification/config");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      enabled: false,
      sinkType: "bot_http",
      url: "",
      secret: "",
      allowPrivateAddress: false,
      panelName: "Minefield Panel",
      excludedInstances: [],
      status: { queued: 0, sent: 0, failed: 0, dropped: 0 }
    });
    expect(Object.keys(r.body.events)).toHaveLength(9);
  });
});

describe("PUT /config", () => {
  it("saves, masks the secret, keeps it on placeholder, and logs without values", async () => {
    const rot = await call("POST", "/notification/secret/rotate");
    const secret = rot.body.secret;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    const put = await call("PUT", "/notification/config", {
      enabled: true,
      url: "https://8.8.8.8/hook",
      secret: MASKED_SECRET,
      events: { "instance.crashed": true },
      excludedInstances: ["d::i"]
    });
    expect(put.status).toBe(200);
    expect(put.body.secret).toBe(MASKED_SECRET);
    expect(put.body.url).toBe("https://8.8.8.8/hook");
    expect(put.body.events["instance.crashed"]).toBe(true);
    expect(put.text).not.toContain(secret);

    // second save with the placeholder: stored secret unchanged
    await call("PUT", "/notification/config", { secret: MASKED_SECRET, panelName: "X" });
    expect(store.get("NotificationConfig/config").secret).toBe(secret);

    // persisted record round-trips
    expect(store.get("NotificationConfig/config")).toMatchObject({ enabled: true, panelName: "X" });

    // the secret never reaches GET, nor the operation log
    const get = await call("GET", "/notification/config");
    expect(get.text).not.toContain(secret);
    expect(JSON.stringify(opLog.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(opLog.mock.calls)).not.toContain("8.8.8.8");
    expect(opLog).toHaveBeenCalled();
  });
  it("masks a discord webhook url", async () => {
    const hook =
      "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKLmnopqrstuvwxyz0123";
    // the host resolves through real DNS on save; stub by preloading config, then re-saving flags
    setNotificationConfigForTest(
      Object.assign(new NotificationConfig(), { sinkType: "discord_webhook", url: hook })
    );
    const get = await call("GET", "/notification/config");
    expect(get.body.url).toBe(MASKED_SECRET);
    expect(get.text).not.toContain("abcDEF");
    const put = await call("PUT", "/notification/config", { url: MASKED_SECRET, enabled: true });
    expect(put.status).toBe(200);
    expect(store.get("NotificationConfig/config").url).toBe(hook);
  });
  it("rejects invalid input with 400 and changes nothing", async () => {
    const bad: any[] = [
      { events: { "nope.type": true } },
      { events: { "instance.crashed": "on" } },
      { enabled: "yes" },
      { sinkType: "slack" },
      { url: "https://u:p@8.8.8.8/x" },
      { url: "ftp://8.8.8.8/x" },
      { url: "http://8.8.8.8/x" },
      { url: "https://10.0.0.5/x" },
      { url: "https://127.0.0.1/x" },
      { url: "https://[::ffff:192.168.0.1]/x" },
      { url: "https://8.8.8.8/" + "a".repeat(600) },
      { sinkType: "discord_webhook", url: "https://evil.example/api/webhooks/1/2" },
      { panelName: "x".repeat(41) },
      { excludedInstances: Array.from({ length: 201 }, (_, i) => `a::${i}`) },
      { excludedInstances: ["bad"] },
      { enabled: true }
    ];
    for (const b of bad) {
      const r = await call("PUT", "/notification/config", b);
      expect(r.status, JSON.stringify(b).slice(0, 80)).toBe(400);
      expect(typeof r.body.data === "string" || typeof r.body === "string").toBe(true);
    }
    expect(store.size).toBe(0);
    const arr = await call("PUT", "/notification/config", [1]);
    expect(arr.status).toBe(400);
  });
  it("allows a private http bot only with the explicit option", async () => {
    const no = await call("PUT", "/notification/config", { url: "http://192.168.1.20:8080/hook" });
    expect(no.status).toBe(400);
    const yes = await call("PUT", "/notification/config", {
      url: "http://192.168.1.20:8080/hook",
      allowPrivateAddress: true
    });
    expect(yes.status).toBe(200);
    expect(yes.body.allowPrivateAddress).toBe(true);
  });
});

describe("POST /secret/rotate", () => {
  it("returns the plaintext once and a different value each time", async () => {
    const a = await call("POST", "/notification/secret/rotate");
    const b = await call("POST", "/notification/secret/rotate");
    expect(a.status).toBe(200);
    expect(Object.keys(a.body)).toEqual(["secret"]);
    expect(a.body.secret).not.toBe(b.body.secret);
    const get = await call("GET", "/notification/config");
    expect(get.body.secret).toBe(MASKED_SECRET);
    expect(store.get("NotificationConfig/config").secret).toBe(b.body.secret);
  });
});

describe("POST /test", () => {
  it("reports not_configured when disabled", async () => {
    const r = await call("POST", "/notification/test");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: false, error: "not_configured" });
    expect(sendEvent).not.toHaveBeenCalled();
  });
  it("sends one attempt and returns ok/status; second call is rate limited", async () => {
    setNotificationConfigForTest(
      Object.assign(new NotificationConfig(), {
        enabled: true,
        url: "https://8.8.8.8/hook",
        secret: "s"
      })
    );
    sendEvent.mockResolvedValue({ ok: true, status: 204, retryable: false });
    const r = await call("POST", "/notification/test");
    expect(r.body).toEqual({ ok: true, status: 204 });
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(sendEvent.mock.calls[0][0].type).toBe("notification.test");
    const again = await call("POST", "/notification/test");
    expect(again.body).toEqual({ ok: false, error: "rate_limited" });
  });
});
