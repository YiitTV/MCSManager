import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { io } from "socket.io-client";
import { afterAll, describe, expect, it } from "vitest";
import {
  world,
  requestPanel,
  setupSecurityWorld,
  createInstance,
  getUploadPassport,
  uploadToDaemon,
  waitFor,
  sleep,
  adm,
  u1,
  u2,
  di,
  STOPPED,
  RUNNING,
  FIXTURE
} from "../lib";

// Notifications (panel API + real daemon + a local HTTP receiver playing the bot). Boots a FRESH
// real daemon + panel. The panel is pointed at http://127.0.0.1:<port>/hook with
// sinkType=bot_http and allowPrivateAddress=true; every request is verified with the rotated
// secret (HMAC-SHA256 over `<timestamp>.<raw body>`).

interface Received {
  id: string;
  type: string;
  ts: string;
  sig: string;
  raw: string;
  body: any;
  status: number;
}

const received: Received[] = [];
let failNext = 0; // answer this many requests with 503
let receiver: http.Server | null = null;
let hookUrl = "";
let secret = "";
let mainUuid = "";
let crashUuid = "";

const ALL_OFF = {
  "instance.crashed": false,
  "instance.started": false,
  "instance.stopped": false,
  "instance.auto_restarted": false,
  "backup.succeeded": false,
  "backup.failed": false,
  "group.run_started": false,
  "group.run_finished": false,
  "group.run_failed": false
};

const sign = (ts: string, raw: string) =>
  "sha256=" +
  createHmac("sha256", Buffer.from(secret, "utf8")).update(`${ts}.${raw}`).digest("hex");

function startReceiver(): Promise<void> {
  return new Promise((resolve) => {
    receiver = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: any = {};
        try {
          body = JSON.parse(raw);
        } catch {}
        const status = failNext > 0 ? 503 : 200;
        if (failNext > 0) failNext--;
        received.push({
          id: String(body.id),
          type: String(body.type),
          ts: String(req.headers["x-minefield-timestamp"] ?? ""),
          sig: String(req.headers["x-minefield-signature"] ?? ""),
          raw,
          body,
          status
        });
        res.statusCode = status;
        res.end("ok");
      });
    });
    receiver.listen(0, "127.0.0.1", () => {
      hookUrl = `http://127.0.0.1:${(receiver!.address() as any).port}/hook`;
      resolve();
    });
  });
}

afterAll(() => {
  receiver?.close();
});

// "key" = integration-key admin bypass; "admin" = admin session (needed where a route reads the user)
const nt = (
  method: "GET" | "PUT" | "POST",
  p: string,
  who: "key" | "admin" | "u1" | "u2" | null,
  body?: any
) =>
  requestPanel({
    method,
    path: `/notification${p}`,
    ...(who === "key"
      ? { key: world.key }
      : who === "admin"
        ? adm()
        : who === "u1"
          ? u1()
          : who === "u2"
            ? u2()
            : {}),
    body
  });

const setConfig = async (body: any) => {
  const r = await nt("PUT", "/config", "key", body);
  expect(r.httpStatus, `config: ${JSON.stringify(r.raw).slice(0, 300)}`).toBe(200);
  return r;
};

const instanceOp = (op: "open" | "stop", uuid: string) =>
  requestPanel({
    method: "GET",
    path: `/protected_instance/${op}`,
    ...adm(),
    query: { daemonId: di(), uuid }
  });

const statusOf = async (uuid: string) =>
  (
    await requestPanel({
      method: "GET",
      path: "/instance",
      ...adm(),
      query: { daemonId: di(), uuid }
    })
  )?.data?.status ?? -99;

// An instance that just started cannot be stopped during the daemon's 2 s start guard
async function startInstance(uuid: string) {
  const r = await instanceOp("open", uuid);
  expect(r.httpStatus, JSON.stringify(r.raw).slice(0, 200)).toBe(200);
  await waitFor(async () => (await statusOf(uuid)) === RUNNING, { timeout: 30000, msg: "running" });
}

async function stopInstance(uuid: string) {
  if ((await statusOf(uuid)) === STOPPED) return;
  await sleep(2500);
  await instanceOp("stop", uuid);
  await waitFor(async () => (await statusOf(uuid)) === STOPPED, { timeout: 40000, msg: "stopped" });
}

const ofType = (type: string, uuid?: string) =>
  received.filter(
    (r) => r.type === type && (uuid === undefined || r.body?.instance?.uuid === uuid)
  );

const waitEvent = (type: string, uuid?: string, count = 1, timeout = 30000) =>
  waitFor(() => ofType(type, uuid).length >= count, {
    timeout,
    interval: 200,
    msg: `event ${type} ${uuid ?? ""}`
  });

async function uploadScript(uuid: string, localPath: string, name: string) {
  const pp = await getUploadPassport(di(), uuid, adm().cookie, adm().token, ".");
  const up = await uploadToDaemon(pp, localPath, name, { unzip: false });
  expect(up.httpStatus, `upload ${name}: ${JSON.stringify(up.data).slice(0, 160)}`).toBe(200);
}

describe("notifications: setup and configuration", () => {
  it("creates users, boots the receiver and configures the panel", async () => {
    await setupSecurityWorld();
    mainUuid = world.instance.uuid!;
    await startReceiver();
    await setConfig({
      enabled: true,
      sinkType: "bot_http",
      url: hookUrl,
      allowPrivateAddress: true,
      panelName: "IT Panel",
      events: {
        ...ALL_OFF,
        "instance.crashed": true,
        "instance.started": true,
        "instance.stopped": true
      }
    });
    const rot = await nt("POST", "/secret/rotate", "key");
    expect(rot.httpStatus).toBe(200);
    secret = rot.data?.secret;
    expect(typeof secret).toBe("string");
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });

  it("GET /config never contains the plaintext secret or a secret-looking value", async () => {
    const r = await nt("GET", "/config", "key");
    expect(r.httpStatus).toBe(200);
    expect(JSON.stringify(r.raw)).not.toContain(secret);
    expect(r.data.secret).not.toBe(secret);
    expect(r.data.secret).toBeTruthy(); // masked placeholder, secret is set
    expect(r.data.enabled).toBe(true);
    expect(r.data.url).toBe(hookUrl);
    // PUT responses do not echo the secret either
    const put = await setConfig({ panelName: "IT Panel" });
    expect(JSON.stringify(put.raw)).not.toContain(secret);
  });

  it("a regular user gets 403 on every /api/notification route", async () => {
    for (const [method, p, body] of [
      ["GET", "/config", undefined],
      ["PUT", "/config", { enabled: false }],
      ["POST", "/secret/rotate", undefined],
      ["POST", "/test", undefined]
    ] as const) {
      for (const who of ["u1", "u2"] as const) {
        const r = await nt(method, p, who, body);
        expect(r.httpStatus, `${who} ${method} ${p}`).toBe(403);
      }
    }
    // nothing changed, no delivery happened
    const cfg = await nt("GET", "/config", "key");
    expect(cfg.data.enabled).toBe(true);
    expect(received.filter((r) => r.type === "notification.test")).toHaveLength(0);
  });
});

describe("notifications: test delivery and signature", () => {
  it("POST /test delivers exactly one signed notification.test request", async () => {
    const r = await nt("POST", "/test", "admin");
    expect(r.httpStatus, JSON.stringify(r.raw).slice(0, 200)).toBe(200);
    expect(r.data).toMatchObject({ ok: true });
    await waitEvent("notification.test");
    await sleep(500);
    const list = ofType("notification.test");
    expect(list).toHaveLength(1);
    const ev = list[0];
    expect(ev.status).toBe(200);
    expect(ev.ts).toMatch(/^\d+$/);
    const skew = Math.abs(Date.now() / 1000 - Number(ev.ts));
    expect(skew).toBeLessThan(120);
    expect(ev.sig).toBe(sign(ev.ts, ev.raw));
    expect(ev.body).toMatchObject({
      version: 1,
      type: "notification.test",
      panel: { name: "IT Panel" }
    });
    expect(typeof ev.body.id).toBe("string");
    // a tampered body would not verify
    expect(ev.sig).not.toBe(sign(ev.ts, ev.raw + " "));
  });
});

describe("notifications: instance lifecycle (real daemon)", () => {
  it("a crash (non-zero exit without a stop) sends exactly one instance.crashed after instance.started", async () => {
    const script = path.join(os.tmpdir(), `mcsm-it-crash-${process.pid}.mjs`);
    fs.writeFileSync(
      script,
      'console.log("about to crash");\nsetTimeout(() => process.exit(3), 2500);\n'
    );
    try {
      crashUuid = await createInstance("mcsm-it-notify-crash", {
        startCommand: "node crash.mjs",
        // The PTY helper does not propagate the child's exit code; use a plain child process
        terminalOption: { haveColor: false, pty: false, ptyWindowCol: 164, ptyWindowRow: 40 }
      });
      await uploadScript(crashUuid, script, "crash.mjs");
    } finally {
      fs.rmSync(script, { force: true });
    }
    expect((await instanceOp("open", crashUuid)).httpStatus).toBe(200);
    await waitEvent("instance.crashed", crashUuid);
    await sleep(3000); // a duplicate, if any, would arrive by now
    const crashed = ofType("instance.crashed", crashUuid);
    expect(crashed).toHaveLength(1);
    expect(crashed[0].sig).toBe(sign(crashed[0].ts, crashed[0].raw));
    expect(crashed[0].body.instance).toMatchObject({
      uuid: crashUuid,
      name: "mcsm-it-notify-crash",
      daemonId: di()
    });
    expect(crashed[0].body.details).toMatchObject({ exitCode: 3, willAutoRestart: false });
    const started = ofType("instance.started", crashUuid);
    expect(started).toHaveLength(1);
    expect(received.indexOf(started[0])).toBeLessThan(received.indexOf(crashed[0]));
    expect(ofType("instance.stopped", crashUuid)).toHaveLength(0);
    await waitFor(async () => (await statusOf(crashUuid)) === STOPPED, { timeout: 20000 });
  });

  it("a normal stop sends instance.stopped and no crash", async () => {
    await startInstance(mainUuid);
    await waitEvent("instance.started", mainUuid);
    await stopInstance(mainUuid);
    await waitEvent("instance.stopped", mainUuid);
    await sleep(1500);
    expect(ofType("instance.stopped", mainUuid)).toHaveLength(1);
    expect(ofType("instance.crashed", mainUuid)).toHaveLength(0);
    expect(ofType("instance.stopped", mainUuid)[0].body.details.exitCode).toBe(0);
  });

  it("unauthenticated daemon sockets never receive lifecycle events", async () => {
    const mk = () =>
      io(world.daemonHttpUrl, {
        path: "/socket.io",
        transports: ["websocket"],
        reconnection: false,
        forceNew: true
      });
    const anon = mk();
    const wrong = mk();
    const seen: string[] = [];
    for (const s of [anon, wrong]) s.onAny((ev: string) => seen.push(ev));
    await waitFor(() => anon.connected && wrong.connected, { timeout: 5000, interval: 50 });
    wrong.emit("auth", { data: "definitely-not-the-daemon-key" });
    const before = ofType("instance.started", mainUuid).length;
    await startInstance(mainUuid);
    await waitEvent("instance.started", mainUuid, before + 1);
    // the panel (authenticated) did get it, the unauthenticated sockets did not
    expect(anon.connected).toBe(true);
    expect(seen.filter((e) => e === "instance/lifecycle")).toEqual([]);
    anon.close();
    wrong.close();
    await stopInstance(mainUuid);
  });
});

describe("notifications: toggles and exclusions", () => {
  it("a disabled event toggle is not delivered", async () => {
    await setConfig({ events: { "instance.started": false } });
    const before = ofType("instance.started", mainUuid).length;
    await startInstance(mainUuid);
    await stopInstance(mainUuid);
    // the stopped event (still enabled) proves the pipeline ran after the start
    await waitEvent("instance.stopped", mainUuid, 3);
    expect(ofType("instance.started", mainUuid)).toHaveLength(before);
    await setConfig({ events: { "instance.started": true } });
  });

  it("an excluded instance is not delivered", async () => {
    await setConfig({ excludedInstances: [`${di()}::${mainUuid}`] });
    const started = ofType("instance.started", mainUuid).length;
    const stopped = ofType("instance.stopped", mainUuid).length;
    await startInstance(mainUuid);
    await stopInstance(mainUuid);
    // sentinel: a non-excluded instance still delivers
    const other = await createInstance("mcsm-it-notify-sentinel");
    await uploadScript(other, FIXTURE, "test.mjs");
    await startInstance(other);
    await waitEvent("instance.started", other);
    await sleep(1000);
    expect(ofType("instance.started", mainUuid)).toHaveLength(started);
    expect(ofType("instance.stopped", mainUuid)).toHaveLength(stopped);
    await stopInstance(other);
    await setConfig({ excludedInstances: [] });
  });
});

describe("notifications: retry", () => {
  it("retries a 503 with the SAME event id and a NEW timestamp and signature", async () => {
    const uuid = await createInstance("mcsm-it-notify-retry");
    await uploadScript(uuid, FIXTURE, "test.mjs");
    failNext = 1;
    await startInstance(uuid);
    // first backoff is 5 s
    await waitEvent("instance.started", uuid, 2, 60000);
    const [first, second] = ofType("instance.started", uuid);
    expect(first.status).toBe(503);
    expect(second.status).toBe(200);
    expect(second.id).toBe(first.id);
    expect(Number(second.ts)).toBeGreaterThanOrEqual(Number(first.ts) + 4);
    expect(second.sig).not.toBe(first.sig);
    expect(first.sig).toBe(sign(first.ts, first.raw));
    expect(second.sig).toBe(sign(second.ts, second.raw));
    await sleep(1500);
    expect(ofType("instance.started", uuid)).toHaveLength(2);
    await stopInstance(uuid);
  }, 120000);
});

describe("notifications: group runs", () => {
  it("a group run sends group.run_started then group.run_finished", async () => {
    await setConfig({
      events: { "group.run_started": true, "group.run_finished": true, "group.run_failed": true }
    });
    const a = await createInstance("mcsm-it-notify-ga");
    const b = await createInstance("mcsm-it-notify-gb");
    await uploadScript(a, FIXTURE, "test.mjs");
    await uploadScript(b, FIXTURE, "test.mjs");
    const adminGrp = (method: "POST" | "PUT", p: string, o: { query?: any; body?: any }) =>
      requestPanel({ method, path: `/instance_group${p}`, ...adm(), query: o.query, body: o.body });
    const created = await adminGrp("POST", "/create", {
      body: {
        name: "IT notify group",
        members: [a, b].map((instanceUuid) => ({ daemonId: di(), instanceUuid }))
      }
    });
    expect(created.httpStatus, JSON.stringify(created.raw).slice(0, 200)).toBe(200);
    const gid = created.data.uuid;
    const upd = await adminGrp("PUT", "/update", {
      query: { id: gid },
      body: { advance: { mode: "running", startTimeoutSec: 60 } }
    });
    expect(upd.httpStatus, JSON.stringify(upd.raw).slice(0, 200)).toBe(200);

    const start = await adminGrp("POST", "/start", { query: { id: gid } });
    expect(start.httpStatus, JSON.stringify(start.raw).slice(0, 200)).toBe(200);
    const runId = start.data.runId;

    await waitEvent("group.run_finished", undefined, 1, 90000);
    await sleep(1000);
    const started = ofType("group.run_started");
    const finished = ofType("group.run_finished");
    expect(started).toHaveLength(1);
    expect(finished).toHaveLength(1);
    expect(received.indexOf(started[0])).toBeLessThan(received.indexOf(finished[0]));
    for (const ev of [started[0], finished[0]]) {
      expect(ev.sig).toBe(sign(ev.ts, ev.raw));
      expect(ev.body.group).toMatchObject({
        uuid: gid,
        name: "IT notify group",
        action: "start",
        runId
      });
    }
    expect(started[0].body.details).toMatchObject({ memberCount: 2 });
    expect(finished[0].body.details).toMatchObject({ result: "succeeded", memberCount: 2 });
    expect(ofType("group.run_failed")).toHaveLength(0);
    await stopInstance(a);
    await stopInstance(b);
  }, 180000);
});
