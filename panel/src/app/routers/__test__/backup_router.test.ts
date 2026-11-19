import http from "node:http";
import Koa from "koa";
import koaBody from "koa-body";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "path";
import { BACKUP_SECRET_MASK } from "mcsmanager-common";

// Route tests: the REAL router, permission middleware, validator and service, with a FAKE daemon
// (RemoteRequest replaced), in-memory storage and a mocked operation logger / logger.

const settingState = vi.hoisted(() => ({ systemConfig: { dataPlane: "direct" } as any }));
vi.mock("../../setting", () => ({
  get systemConfig() {
    return settingState.systemConfig;
  },
  saveSystemConfig: vi.fn()
}));
vi.mock(
  "../../common/storage/sys_storage",
  async () => (await import("../../service/__test__/fake_daemon")).sysStorageMock
);
vi.mock(
  "../../service/remote_command",
  async () => (await import("../../service/__test__/fake_daemon")).remoteCommandMock
);
vi.mock(
  "../../service/remote_service",
  async () => (await import("../../service/__test__/fake_daemon")).remoteServiceMock
);
vi.mock(
  "../../service/log",
  async () => (await import("../../service/__test__/fake_daemon")).logMock
);
vi.mock("../../service/operation_logger", () => ({
  operationLogger: { log: vi.fn() },
  getOperationLoggerOperator: () => ({ operator_ip: "127.0.0.1", operator_name: "tester" })
}));
// speedLimit keeps process-wide per-user state; it is covered by its own middleware behaviour
vi.mock("../../middleware/limit", () => ({
  speedLimit: () => async (_ctx: any, next: () => Promise<void>) => next()
}));
vi.mock("../../service/instance_name_service", () => ({
  getInstanceNameSafely: async () => "My Server"
}));

import { User } from "../../entity/user";
import { fakeDaemon, logMock, memoryStore } from "../../service/__test__/fake_daemon";
import { setBackupSecretKeyFileForTest, encryptSecret } from "../../service/backup_secret";
import { clearStatesForTest, setGoogleTokenFetchForTest } from "../../service/backup_oauth";
import {
  resetRunSlotsForTest,
  getStoredDestination,
  toPlainDestination
} from "../../service/backup_service";
import { verifyProxyToken } from "../../service/gateway_token";
import userSystem from "../../service/user_service";
import router from "../backup_router";

const TOKEN = "tok";
const SECRET = "SUPER-SECRET-ACCESS-KEY-123";
const GSECRET = "GOOGLE-CLIENT-SECRET-XYZ";
const REFRESH = "1//REFRESH-TOKEN-VALUE-ABC";
const sessions: Record<string, { uuid: string; userName: string }> = {
  admin: { uuid: "adminuuid", userName: "admin" },
  admin2: { uuid: "admin2uuid", userName: "admin2" },
  alice: { uuid: "aliceuuid", userName: "alice" },
  bob: { uuid: "bobuuid", userName: "bob" }
};

function addUser(who: string, permission: number, instances: string[]) {
  const user = new User();
  user.uuid = sessions[who].uuid;
  user.userName = who;
  user.permission = permission;
  user.instances = instances.map((instanceUuid) => ({ daemonId: "d1", instanceUuid }));
  userSystem.setInstance(user.uuid, user);
}

let server: http.Server;
let base = "";
let dir = "";

beforeAll(async () => {
  const app = new Koa();
  app.use(
    koaBody({
      multipart: false,
      jsonLimit: "1mb",
      parsedMethods: ["GET", "PUT", "POST", "DELETE"] as any
    })
  );
  app.use(async (ctx, next) => {
    const who = ctx.get("x-test-user");
    (ctx as any).session = sessions[who] ? { login: true, token: TOKEN, ...sessions[who] } : {};
    await next();
    if (ctx.status >= 300 && ctx.status < 400) return;
    if (typeof ctx.body === "string")
      ctx.body = JSON.stringify({ status: ctx.status, data: ctx.body });
    else if (ctx.status === 200) ctx.body = JSON.stringify({ status: 200, data: ctx.body });
  });
  app.use(router.routes());
  await new Promise<void>((resolve) => (server = app.listen(0, "127.0.0.1", resolve)));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bk-router-"));
  setBackupSecretKeyFileForTest(path.join(dir, "key"));
  memoryStore.clear();
  fakeDaemon.reset();
  resetRunSlotsForTest();
  clearStatesForTest();
  setGoogleTokenFetchForTest(null);
  settingState.systemConfig = { dataPlane: "direct" };
  vi.clearAllMocks();
  addUser("admin", 10, []);
  addUser("admin2", 10, []);
  addUser("alice", 1, ["inst1"]);
  addUser("bob", 1, ["other"]);
  fakeDaemon.on("instance/detail", () => ({ status: 0 }));
  fakeDaemon.on("schedule/delete", () => true);
  fakeDaemon.on("schedule/register", () => true);
  fakeDaemon.on("backup/run", () => ({ backupId: "bk1" }));
  fakeDaemon.on("backup/records", () => ({
    records: [
      {
        id: "bk1",
        planId: "p",
        createdAt: 1,
        sizeBytes: 10,
        sha256: "a".repeat(64),
        trigger: "manual",
        warnings: [],
        copies: {
          local: { status: "ok", type: "local", name: "Local", remoteId: "secret-remote-key.zip" }
        }
      }
    ]
  }));
  fakeDaemon.on("backup/status", () => ({ queued: [] }));
  fakeDaemon.on("backup/cancel", () => ({ cancelled: true }));
  fakeDaemon.on("backup/restore", () => ({ jobId: "j1" }));
  fakeDaemon.on("backup/test_destination", () => ({ ok: true }));
  fakeDaemon.on("backup/download_ticket", () => ({
    ticket: "TICKET-OPAQUE-VALUE",
    fileName: "p_bk1.zip",
    sizeBytes: 10,
    expiresAt: Date.now() + 60000
  }));
  fakeDaemon.on("passport/register", () => true);
});

async function call(
  who: string | null,
  method: string,
  p: string,
  body?: unknown,
  opts: { api?: boolean; manual?: boolean } = {}
) {
  const url = new URL(base + p);
  if (who && opts.api !== false) url.searchParams.set("token", TOKEN);
  const res = await fetch(url, {
    method,
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      ...(who ? { "x-test-user": who } : {}),
      ...(who && opts.api !== false ? { "x-requested-with": "XMLHttpRequest" } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { http: res.status, data: parsed?.data, text, location: res.headers.get("location") };
}

const s3 = (over: any = {}) => ({
  type: "s3",
  name: "Minio",
  config: {
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "my-bucket",
    pathStyle: true,
    allowPrivateNetwork: false,
    accessKeyId: "AKIAEXAMPLE"
  },
  secrets: { secretAccessKey: SECRET },
  ...over
});
const gdrive = () => ({
  type: "gdrive",
  name: "Drive",
  config: {
    authMethod: "oauth",
    clientId: "client-123.apps.googleusercontent.com",
    redirectBaseUrl: "https://panel.example.com"
  },
  secrets: { clientSecret: GSECRET }
});
const planBody = (over: any = {}) => ({
  daemonId: "d1",
  uuid: "inst1",
  name: "Nightly",
  preset: "minecraft-worlds",
  retention: 3,
  destinationIds: ["local"],
  minecraftSaveHook: true,
  enabled: true,
  ...over
});

async function setup() {
  const d = (await call("admin", "POST", "/backup/destinations", s3())).data;
  const plan = (
    await call("admin", "POST", "/backup/plans", planBody({ destinationIds: ["local", d.id] }))
  ).data;
  return { dest: d, plan };
}

describe("authentication and role denials", () => {
  it("rejects anonymous requests", async () => {
    expect((await call(null, "GET", "/backup/destinations")).http).toBe(403);
    expect((await call(null, "POST", "/backup/run", {})).http).toBe(403);
  });

  it("regular users cannot touch destinations, plans, restore, cancel or OAuth", async () => {
    const { dest, plan } = await setup();
    const denied: [string, string, unknown?][] = [
      ["GET", "/backup/destinations"],
      ["POST", "/backup/destinations", s3()],
      ["PUT", "/backup/destinations", { ...s3(), id: dest.id }],
      ["DELETE", "/backup/destinations", { id: dest.id }],
      ["POST", "/backup/destinations/test", { destination: s3() }],
      ["GET", `/backup/gdrive/connect?destinationId=${dest.id}`],
      ["POST", "/backup/plans", planBody()],
      ["PUT", "/backup/plans", { id: plan.id, name: "x" }],
      ["DELETE", "/backup/plans", { planId: plan.id }],
      ["POST", "/backup/restore", { daemonId: "d1", uuid: "inst1", recordId: "bk1" }],
      ["POST", "/backup/cancel", { daemonId: "d1", uuid: "inst1", backupId: "bk1" }]
    ];
    const before = JSON.stringify([...memoryStore.entries()]);
    for (const [method, url, b] of denied) {
      const r = await call("alice", method, url, b);
      expect(r.http, `${method} ${url}`).toBe(403);
    }
    expect(JSON.stringify([...memoryStore.entries()])).toBe(before);
    expect(fakeDaemon.callsOf("backup/restore")).toHaveLength(0);
    expect(fakeDaemon.callsOf("backup/cancel")).toHaveLength(0);
    expect(fakeDaemon.callsOf("backup/test_destination")).toHaveLength(0);
  });

  it("users act only on assigned instances", async () => {
    const { plan } = await setup();
    const q = "daemonId=d1&uuid=inst1";
    expect((await call("bob", "GET", `/backup/plans?${q}`)).http).toBe(403);
    expect((await call("bob", "GET", `/backup/records?${q}`)).http).toBe(403);
    expect((await call("bob", "GET", `/backup/jobs?${q}`)).http).toBe(403);
    expect(
      (await call("bob", "POST", "/backup/run", { daemonId: "d1", uuid: "inst1", planId: plan.id }))
        .http
    ).toBe(403);
    expect(
      (
        await call("bob", "POST", "/backup/download", {
          daemonId: "d1",
          uuid: "inst1",
          recordId: "bk1"
        })
      ).http
    ).toBe(403);
    expect(fakeDaemon.callsOf("backup/run")).toHaveLength(0);
    expect(fakeDaemon.callsOf("backup/download_ticket")).toHaveLength(0);

    expect((await call("alice", "GET", `/backup/plans?${q}`)).http).toBe(200);
    expect((await call("alice", "GET", `/backup/jobs?${q}`)).http).toBe(200);
    expect(
      (
        await call("alice", "POST", "/backup/run", {
          daemonId: "d1",
          uuid: "inst1",
          planId: plan.id
        })
      ).data
    ).toEqual({ backupId: "bk1" });
  });

  it("a plan id of another instance cannot be run through an assigned instance", async () => {
    const { plan } = await setup();
    addUser("alice", 1, ["inst1", "inst2"]);
    const r = await call("alice", "POST", "/backup/run", {
      daemonId: "d1",
      uuid: "inst2",
      planId: plan.id
    });
    expect(r.http).toBe(404);
    expect(fakeDaemon.callsOf("backup/run")).toHaveLength(0);
  });
});

describe("users see redacted data", () => {
  it("records without remote ids, plans with destination names only", async () => {
    const { dest } = await setup();
    const q = "daemonId=d1&uuid=inst1";
    const userRecords = await call("alice", "GET", `/backup/records?${q}`);
    expect(userRecords.text).not.toContain("secret-remote-key.zip");
    expect(userRecords.data[0].copies.local.remoteId).toBeUndefined();
    const adminRecords = await call("admin", "GET", `/backup/records?${q}`);
    expect(adminRecords.data[0].copies.local.remoteId).toBe("secret-remote-key.zip");
    const plans = (await call("alice", "GET", `/backup/plans?${q}`)).data;
    expect(plans[0].destinations).toEqual([
      { id: "local", name: "Local", type: "local" },
      { id: dest.id, name: "Minio", type: "s3" }
    ]);
    const text = JSON.stringify(plans);
    expect(text).not.toContain("s3.example.com");
    expect(text).not.toContain("my-bucket");
  });
});

describe("secrets never leave the panel", () => {
  it("are masked in every response and absent from logs", async () => {
    const { dest, plan } = await setup();
    const g = (await call("admin", "POST", "/backup/destinations", gdrive())).data;
    const responses: string[] = [];
    const record = (r: { text: string }) => responses.push(r.text);
    record(await call("admin", "POST", "/backup/destinations", s3({ name: "second" })));
    record(await call("admin", "GET", "/backup/destinations"));
    record(
      await call("admin", "PUT", "/backup/destinations", {
        ...s3({ name: "renamed" }),
        id: dest.id,
        secrets: { secretAccessKey: BACKUP_SECRET_MASK }
      })
    );
    record(
      await call("admin", "POST", "/backup/destinations/test", {
        destination: { ...s3(), id: dest.id, secrets: { secretAccessKey: BACKUP_SECRET_MASK } }
      })
    );
    record(await call("admin", "GET", `/backup/gdrive/connect?destinationId=${g.id}`));
    record(await call("admin", "GET", "/backup/plans?daemonId=d1&uuid=inst1"));
    record(await call("admin", "PUT", "/backup/plans", { id: plan.id, name: "again" }));
    record(await call("alice", "GET", "/backup/plans?daemonId=d1&uuid=inst1"));
    record(await call("alice", "GET", "/backup/records?daemonId=d1&uuid=inst1"));
    // error responses
    record(
      await call(
        "admin",
        "POST",
        "/backup/destinations",
        s3({ secrets: { secretAccessKey: BACKUP_SECRET_MASK } })
      )
    );
    record(await call("admin", "DELETE", "/backup/destinations", { id: dest.id }));
    const all = responses.join("\n");
    for (const secret of [SECRET, GSECRET]) expect(all).not.toContain(secret);
    expect(all).toContain(BACKUP_SECRET_MASK);
    const logged = JSON.stringify(
      [logMock.logger.info, logMock.logger.warn, logMock.logger.error].map(
        (f) => (f as any).mock.calls
      )
    );
    for (const secret of [SECRET, GSECRET]) expect(logged).not.toContain(secret);
    // and not stored in clear
    expect(JSON.stringify([...memoryStore.values()])).not.toContain(SECRET);
    expect(JSON.stringify([...memoryStore.values()])).not.toContain(GSECRET);
  });

  it("masked update keeps the stored secret (verified via the daemon request)", async () => {
    const { dest, plan } = await setup();
    const r = await call("admin", "PUT", "/backup/destinations", {
      ...s3({ name: "Renamed" }),
      id: dest.id,
      secrets: { secretAccessKey: BACKUP_SECRET_MASK }
    });
    expect(r.http).toBe(200);
    expect(r.data.secrets.secretAccessKey).toBe(BACKUP_SECRET_MASK);
    await call("admin", "POST", "/backup/run", { daemonId: "d1", uuid: "inst1", planId: plan.id });
    const run = fakeDaemon.callsOf("backup/run")[0];
    const sent = run.data.destinations.find((d: any) => d.id === dest.id);
    expect(sent.name).toBe("Renamed");
    expect(sent.secrets.secretAccessKey).toBe(SECRET);
    expect(run.daemonId).toBe("d1");
  });

  it("is never present in a user-facing backup/run response", async () => {
    const { plan } = await setup();
    const r = await call("alice", "POST", "/backup/run", {
      daemonId: "d1",
      uuid: "inst1",
      planId: plan.id
    });
    expect(r.text).not.toContain(SECRET);
    expect(fakeDaemon.callsOf("backup/run")[0].data.initiatedBy).toBe("alice");
    expect(fakeDaemon.callsOf("backup/run")[0].data.trigger).toBe("manual");
  });
});

describe("validation and conflicts", () => {
  it("returns typed errors", async () => {
    const { dest } = await setup();
    expect((await call("admin", "POST", "/backup/plans", planBody({ retention: 0 }))).http).toBe(
      400
    );
    expect(
      (
        await call(
          "admin",
          "POST",
          "/backup/plans",
          planBody({ preset: "custom", include: ["../x"] })
        )
      ).http
    ).toBe(400);
    expect(
      (
        await call(
          "admin",
          "POST",
          "/backup/destinations",
          s3({ config: { ...s3().config, endpoint: "https://u:p@h.com" } })
        )
      ).http
    ).toBe(400);
    const del = await call("admin", "DELETE", "/backup/destinations", { id: dest.id });
    expect(del.http).toBe(409);
    expect((await call("admin", "GET", "/backup/records?daemonId=../x&uuid=inst1")).http).toBe(400);
  });
});

describe("run rate limit", () => {
  it("allows one run per user per plan per 60 s; admins are not limited; failures release the slot", async () => {
    const { plan } = await setup();
    const body = { daemonId: "d1", uuid: "inst1", planId: plan.id };
    expect((await call("alice", "POST", "/backup/run", body)).http).toBe(200);
    expect((await call("alice", "POST", "/backup/run", body)).http).toBe(429);
    expect((await call("admin", "POST", "/backup/run", body)).http).toBe(200);
    expect((await call("admin", "POST", "/backup/run", body)).http).toBe(200);
    expect(fakeDaemon.callsOf("backup/run")).toHaveLength(3);

    resetRunSlotsForTest();
    fakeDaemon.on("backup/run", () => {
      throw new Error("BACKUP_BUSY");
    });
    expect((await call("alice", "POST", "/backup/run", body)).http).toBe(400);
    fakeDaemon.on("backup/run", () => ({ backupId: "bk2" }));
    expect((await call("alice", "POST", "/backup/run", body)).http).toBe(200);
  });

  it("refuses a disabled plan", async () => {
    const { plan } = await setup();
    await call("admin", "PUT", "/backup/plans", { id: plan.id, enabled: false });
    expect(
      (
        await call("alice", "POST", "/backup/run", {
          daemonId: "d1",
          uuid: "inst1",
          planId: plan.id
        })
      ).http
    ).toBe(409);
  });
});

describe("restore", () => {
  it("requires a stopped instance", async () => {
    await setup();
    fakeDaemon.on("instance/detail", () => ({ status: 3 }));
    const body = { daemonId: "d1", uuid: "inst1", recordId: "bk1" };
    const running = await call("admin", "POST", "/backup/restore", body);
    expect(running.http).toBe(409);
    expect(fakeDaemon.callsOf("backup/restore")).toHaveLength(0);
    fakeDaemon.on("instance/detail", () => ({ status: 0 }));
    expect((await call("admin", "POST", "/backup/restore", body)).data).toEqual({ jobId: "j1" });
  });
});

describe("download", () => {
  it("direct mode registers a single-use daemon passport and hides the ticket", async () => {
    const { dest } = await setup();
    const local = (await getStoredDestination("local"))!;
    fakeDaemon.on("backup/records", () => ({
      records: [
        {
          id: "bk1",
          copies: {
            local: { status: "ok", type: "local", remoteId: "p_bk1.zip" },
            [dest.id]: { status: "ok", type: "s3", remoteId: "remote.zip" }
          }
        }
      ]
    }));
    const r = await call("alice", "POST", "/backup/download", {
      daemonId: "d1",
      uuid: "inst1",
      recordId: "bk1",
      destinations: [{ id: "local", config: { directory: "/client-supplied" } }]
    });
    expect(r.http).toBe(200);
    expect(fakeDaemon.callsOf("backup/download_ticket").map((c) => c.data)).toEqual([
      { instanceUuid: "inst1", recordId: "bk1", destinations: [toPlainDestination(local)] }
    ]);
    expect(r.data.fileName).toBe("p_bk1.zip");
    expect(r.text).not.toContain("TICKET-OPAQUE-VALUE");
    const reg = fakeDaemon.callsOf("passport/register")[0];
    expect(reg.data).toMatchObject({
      name: "download",
      parameter: { fileName: "TICKET-OPAQUE-VALUE", instanceUuid: "inst1" }
    });
  });

  it("proxy mode issues a single-use gateway token bound to the ticket", async () => {
    settingState.systemConfig = { dataPlane: "proxy", gatewaySecret: "s".repeat(32) };
    const r = await call("alice", "POST", "/backup/download", {
      daemonId: "d1",
      uuid: "inst1",
      recordId: "bk1"
    });
    expect(r.http).toBe(200);
    const binding = verifyProxyToken(r.data.password, "download");
    expect(binding).toMatchObject({
      daemonId: "d1",
      instanceUuid: "inst1",
      op: "download",
      target: "TICKET-OPAQUE-VALUE"
    });
    expect(verifyProxyToken(r.data.password, "download")).toBeNull();
  });

  it("unassigned users get nothing", async () => {
    const r = await call("bob", "POST", "/backup/download", {
      daemonId: "d1",
      uuid: "inst1",
      recordId: "bk1"
    });
    expect(r.http).toBe(403);
  });
});

describe("Google OAuth", () => {
  async function connect(who = "admin") {
    const g = (await call("admin", "POST", "/backup/destinations", gdrive())).data;
    const r = await call(who, "GET", `/backup/gdrive/connect?destinationId=${g.id}`);
    return { g, r };
  }

  it("builds the consent URL with offline access and the drive.file scope", async () => {
    const { r } = await connect();
    const url = new URL(r.data.url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://panel.example.com/api/backup/gdrive/callback"
    );
    expect(url.searchParams.get("state")).toMatch(/^[a-f0-9]{32}$/);
    expect(r.text).not.toContain(GSECRET);
  });

  it("needs an OAuth destination with a redirect base url", async () => {
    const sa = (await call("admin", "POST", "/backup/destinations", s3())).data;
    expect((await call("admin", "GET", `/backup/gdrive/connect?destinationId=${sa.id}`)).http).toBe(
      400
    );
    const noBase = gdrive();
    delete (noBase.config as any).redirectBaseUrl;
    const g = (await call("admin", "POST", "/backup/destinations", noBase)).data;
    expect((await call("admin", "GET", `/backup/gdrive/connect?destinationId=${g.id}`)).http).toBe(
      400
    );
  });

  function fakeGoogle(status = 200, body: any = { refresh_token: REFRESH, access_token: "at" }) {
    const calls: { url: string; body: string }[] = [];
    setGoogleTokenFetchForTest(async (url, init) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify(body), { status });
    });
    return calls;
  }

  it("exchanges the code on the hardcoded Google host and stores the token encrypted", async () => {
    const calls = fakeGoogle();
    const { g, r } = await connect();
    const state = new URL(r.data.url).searchParams.get("state")!;
    const cb = await call(
      "admin",
      "GET",
      `/backup/gdrive/callback?code=abc&state=${state}`,
      undefined,
      { api: false }
    );
    expect(cb.http).toBe(302);
    expect(cb.location).toContain("backupGdrive=connected");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(calls[0].body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("redirect_uri")).toBe("https://panel.example.com/api/backup/gdrive/callback");
    expect(JSON.stringify([...memoryStore.values()])).not.toContain(REFRESH);
    const stored = toPlainDestination((await getStoredDestination(g.id))!);
    expect((stored.secrets as any).refreshToken).toBe(REFRESH);
    // never logged or shown
    const logged = JSON.stringify(
      [logMock.logger.info, logMock.logger.warn, logMock.logger.error].map(
        (f) => (f as any).mock.calls
      )
    );
    expect(logged).not.toContain(REFRESH);
    expect(logged).not.toContain(GSECRET);
    expect(cb.location).not.toContain(REFRESH);
    const listed = await call("admin", "GET", "/backup/destinations");
    expect(listed.text).not.toContain(REFRESH);
  });

  it("rejects a reused state", async () => {
    fakeGoogle();
    const { r } = await connect();
    const state = new URL(r.data.url).searchParams.get("state")!;
    const first = await call(
      "admin",
      "GET",
      `/backup/gdrive/callback?code=abc&state=${state}`,
      undefined,
      { api: false }
    );
    expect(first.location).toContain("connected");
    const second = await call(
      "admin",
      "GET",
      `/backup/gdrive/callback?code=abc&state=${state}`,
      undefined,
      { api: false }
    );
    expect(second.location).toContain("backupGdrive=error");
    expect(second.location).toContain("OAUTH_STATE_INVALID");
  });

  it("rejects an expired state", async () => {
    const calls = fakeGoogle();
    const { r } = await connect();
    const state = new URL(r.data.url).searchParams.get("state")!;
    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000 + 1000);
    try {
      const cb = await call(
        "admin",
        "GET",
        `/backup/gdrive/callback?code=abc&state=${state}`,
        undefined,
        { api: false }
      );
      expect(cb.location).toContain("OAUTH_STATE_INVALID");
    } finally {
      spy.mockRestore();
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects missing, malformed and unknown states and a state started by another admin", async () => {
    const calls = fakeGoogle();
    const { r } = await connect();
    const state = new URL(r.data.url).searchParams.get("state")!;
    for (const q of [
      "code=abc",
      "code=abc&state=",
      "code=abc&state=zzzz",
      `code=abc&state=${"0".repeat(32)}`
    ]) {
      const cb = await call("admin", "GET", `/backup/gdrive/callback?${q}`, undefined, {
        api: false
      });
      expect(cb.location, q).toContain("OAUTH_STATE_INVALID");
    }
    const other = await call(
      "admin2",
      "GET",
      `/backup/gdrive/callback?code=abc&state=${state}`,
      undefined,
      { api: false }
    );
    expect(other.location).toContain("OAUTH_STATE_INVALID");
    // the state was burnt by the foreign attempt
    const owner = await call(
      "admin",
      "GET",
      `/backup/gdrive/callback?code=abc&state=${state}`,
      undefined,
      { api: false }
    );
    expect(owner.location).toContain("OAUTH_STATE_INVALID");
    expect(calls).toHaveLength(0);
  });

  it("rejects non-admin and anonymous callbacks without touching Google", async () => {
    const calls = fakeGoogle();
    const { r } = await connect();
    const state = new URL(r.data.url).searchParams.get("state")!;
    expect(
      (
        await call("alice", "GET", `/backup/gdrive/callback?code=abc&state=${state}`, undefined, {
          api: false
        })
      ).http
    ).toBe(403);
    expect(
      (
        await call(null, "GET", `/backup/gdrive/callback?code=abc&state=${state}`, undefined, {
          api: false
        })
      ).http
    ).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("reports exchange failures with a short code only", async () => {
    fakeGoogle(400, { error: "invalid_grant", error_description: GSECRET });
    const { g, r } = await connect();
    const state = new URL(r.data.url).searchParams.get("state")!;
    const cb = await call(
      "admin",
      "GET",
      `/backup/gdrive/callback?code=abc&state=${state}`,
      undefined,
      { api: false }
    );
    expect(cb.location).toContain("OAUTH_EXCHANGE_FAILED");
    expect(cb.location).not.toContain(GSECRET);
    expect(
      (toPlainDestination((await getStoredDestination(g.id))!).secrets as any).refreshToken
    ).toBeUndefined();
  });

  it("treats a denied consent as an error and burns the state", async () => {
    const { r } = await connect();
    const state = new URL(r.data.url).searchParams.get("state")!;
    const cb = await call(
      "admin",
      "GET",
      `/backup/gdrive/callback?error=access_denied&state=${state}`,
      undefined,
      { api: false }
    );
    expect(cb.location).toContain("OAUTH_DENIED");
    const again = await call(
      "admin",
      "GET",
      `/backup/gdrive/callback?code=abc&state=${state}`,
      undefined,
      { api: false }
    );
    expect(again.location).toContain("OAUTH_STATE_INVALID");
  });

  it("refuses a destination changed during consent", async () => {
    fakeGoogle();
    const { g, r } = await connect();
    const state = new URL(r.data.url).searchParams.get("state")!;
    await call("admin", "PUT", "/backup/destinations", {
      ...gdrive(),
      id: g.id,
      config: { ...gdrive().config, clientId: "another-client.apps.googleusercontent.com" },
      secrets: { clientSecret: "NEW-CLIENT-SECRET" }
    });
    const cb = await call(
      "admin",
      "GET",
      `/backup/gdrive/callback?code=abc&state=${state}`,
      undefined,
      { api: false }
    );
    expect(cb.location).toContain("OAUTH_DESTINATION_CHANGED");
  });
});

void encryptSecret;
