import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  world,
  requestPanel,
  setupSecurityWorld,
  createInstance,
  assignToU1,
  getUploadPassport,
  uploadToDaemon,
  readFileText,
  waitFor,
  adm,
  u1,
  di,
  STOPPED,
  RUNNING
} from "../lib";

// Instance groups (panel API + real daemon). Boots a FRESH real daemon + panel
// (run.mjs runs one suite file per vitest invocation). Self-contained: the first
// `it` creates admin/u1/u2, the main instance (assigned to u1) and uploads the
// test.mjs fixture.
//
// Users: admin = ROLE.ADMIN, u1 = regular user owning the main instance (and
// whatever assignToU1 sets), u2 = regular user with no instances.

type Who = "admin" | "u1" | "u2";

const as = (who: Who) => ({ cookie: world[who].cookie!, token: world[who].token! });

function grp(
  who: Who | null,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  o: { query?: Record<string, any>; body?: any } = {}
) {
  return requestPanel({
    method,
    path: `/instance_group${path}`,
    ...(who ? as(who) : {}),
    query: o.query,
    body: o.body
  });
}

const member = (instanceUuid: string) => ({ daemonId: di(), instanceUuid });

async function listOf(who: Who): Promise<any[]> {
  const r = await grp(who, "GET", "/list");
  expect(r.httpStatus, `list ${who}: ${JSON.stringify(r.raw).slice(0, 200)}`).toBe(200);
  expect(Array.isArray(r.data)).toBe(true);
  return r.data;
}

async function createGroup(who: Who, body: any) {
  const r = await grp(who, "POST", "/create", { body });
  expect(r.httpStatus, `create: ${JSON.stringify(r.raw).slice(0, 200)}`).toBe(200);
  expect(r.data?.uuid).toBeTruthy();
  return r.data;
}

let main = "";
let other = "";
let third = "";

describe("instance groups: setup", () => {
  it("creates admin/u1/u2, the main instance (assigned to u1) and two unassigned instances", async () => {
    await setupSecurityWorld();
    main = world.instance.uuid!;
    other = await createInstance("mcsm-it-grp-other");
    third = await createInstance("mcsm-it-grp-third");
  });
});

describe("instance groups: CRUD as admin and as a regular user", () => {
  let adminGroup = "";
  let userGroup = "";

  it("admin creates a group with any instances; list returns it with name and stopped status", async () => {
    const g = await createGroup("admin", {
      name: "Admin net",
      members: [member(main), member(other)]
    });
    adminGroup = g.uuid;
    expect(g.name).toBe("Admin net");
    expect(g.members).toHaveLength(2);
    expect(g.members[0]).toMatchObject({ instanceUuid: main, available: true, status: 0 });
    expect(typeof g.members[0].nickname).toBe("string");
    // defaults
    expect(g.advance).toMatchObject({
      mode: "pattern",
      pattern: "Done (*)!",
      startTimeoutSec: 180,
      stopTimeoutSec: 180
    });
    expect(g.stopOrder).toEqual([`${di()}::${main}`, `${di()}::${other}`]);

    const list = await listOf("admin");
    expect(list.map((x) => x.uuid)).toEqual([adminGroup]);
  });

  it("regular user creates a group from an assigned instance", async () => {
    const g = await createGroup("u1", { name: "U1 net", members: [member(main)] });
    userGroup = g.uuid;
    expect(g.members[0]).toMatchObject({ instanceUuid: main, available: true });
    expect((await listOf("u1")).map((x) => x.uuid)).toEqual([userGroup]);
  });

  it("administrator lists only own groups; the regular user's group is not visible", async () => {
    const adminList = await listOf("admin");
    expect(adminList.map((x) => x.uuid)).not.toContain(userGroup);
    const u1List = await listOf("u1");
    expect(u1List.map((x) => x.uuid)).not.toContain(adminGroup);
  });

  it("update renames, reorders the stop order only, and persists", async () => {
    const stopOrder = [`${di()}::${other}`, `${di()}::${main}`];
    const r = await grp("admin", "PUT", "/update", {
      query: { id: adminGroup },
      body: { name: "Renamed", stopOrder, advance: { mode: "running", stopTimeoutSec: 30 } }
    });
    expect(r.httpStatus, JSON.stringify(r.raw).slice(0, 200)).toBe(200);
    const [again] = (await listOf("admin")).filter((x) => x.uuid === adminGroup);
    expect(again.name).toBe("Renamed");
    expect(again.stopOrder).toEqual(stopOrder);
    // start order unchanged
    expect(again.members.map((m: any) => m.instanceUuid)).toEqual([main, other]);
    expect(again.advance).toMatchObject({
      mode: "running",
      stopTimeoutSec: 30,
      startTimeoutSec: 180
    });
  });

  it("update appends a new member to the stop order", async () => {
    const r = await grp("admin", "PUT", "/update", {
      query: { id: adminGroup },
      body: { members: [member(main), member(other), member(third)] }
    });
    expect(r.httpStatus).toBe(200);
    expect(r.data.stopOrder).toEqual([
      `${di()}::${other}`,
      `${di()}::${main}`,
      `${di()}::${third}`
    ]);
  });

  it("delete removes the group; deleting again is not found", async () => {
    const d = await grp("admin", "DELETE", "/delete", { query: { id: adminGroup } });
    expect(d.httpStatus).toBe(200);
    expect((await listOf("admin")).map((x) => x.uuid)).not.toContain(adminGroup);
    const again = await grp("admin", "DELETE", "/delete", { query: { id: adminGroup } });
    expect(again.httpStatus).toBe(404);
  });

  it("requests without a session or token are refused", async () => {
    const noSession = await grp(null, "GET", "/list");
    expect(noSession.httpStatus).toBe(403);
    const noToken = await requestPanel({
      method: "GET",
      path: "/instance_group/list",
      cookie: world.u1.cookie!
    });
    expect(noToken.httpStatus).toBe(403);
  });
});

describe("instance groups: a regular user cannot add instances they are not assigned", () => {
  it("create with an unassigned instance is 403 and nothing is stored", async () => {
    const before = await listOf("u1");
    const r = await grp("u1", "POST", "/create", {
      body: { name: "Sneaky", members: [member(main), member(other)] }
    });
    expect(r.httpStatus).toBe(403);
    expect(await listOf("u1")).toHaveLength(before.length);
  });

  it("update with an unassigned instance is 403 and the group is unchanged", async () => {
    const [g] = await listOf("u1");
    const r = await grp("u1", "PUT", "/update", {
      query: { id: g.uuid },
      body: { members: [member(main), member(other)] }
    });
    expect(r.httpStatus).toBe(403);
    const [after] = await listOf("u1");
    expect(after.members).toHaveLength(1);
  });

  it("a group may not be created for a never-existing daemon or instance", async () => {
    const r = await grp("u1", "POST", "/create", {
      body: { name: "ghost", members: [{ daemonId: "nope", instanceUuid: "nope" }] }
    });
    expect(r.httpStatus).toBe(403);
  });
});

describe("instance groups: validation of tampered input", () => {
  const bad = async (body: any, status = 400) => {
    const r = await grp("u1", "POST", "/create", { body });
    expect(
      r.httpStatus,
      `${JSON.stringify(body).slice(0, 120)} -> ${JSON.stringify(r.raw).slice(0, 160)}`
    ).toBe(status);
  };

  it("rejects bad names", async () => {
    await bad({ name: "", members: [] });
    await bad({ name: "   ", members: [] });
    await bad({ name: "x".repeat(41), members: [] });
    await bad({ name: 5, members: [] });
    await bad({ members: [] });
  });

  it("rejects non-object bodies", async () => {
    await bad("just a string");
    await bad([1, 2, 3]);
  });

  it("rejects malformed members, duplicates and non-permutation stop orders", async () => {
    await bad({ name: "x", members: "nope" });
    await bad({ name: "x", members: [{ daemonId: 1, instanceUuid: main }] });
    await bad({ name: "x", members: [{ daemonId: di(), instanceUuid: "" }] });
    await bad({ name: "x", members: [{ daemonId: di() }] });
    await bad({ name: "x", members: [{ daemonId: di(), instanceUuid: "../../etc/passwd" }] });
    await bad({ name: "x", members: [{ daemonId: "d".repeat(129), instanceUuid: main }] });
    await bad({ name: "x", members: [member(main), member(main)] });
    await bad({ name: "x", members: [member(main)], stopOrder: [] });
    await bad({ name: "x", members: [member(main)], stopOrder: [`${di()}::${other}`] });
    await bad({
      name: "x",
      members: [member(main)],
      stopOrder: [`${di()}::${main}`, `${di()}::${main}`]
    });
    await bad({ name: "x", members: [member(main)], stopOrder: "x" });
  });

  it("rejects more than 30 members", async () => {
    const many = Array.from({ length: 31 }, (_, i) => ({
      daemonId: di(),
      instanceUuid: `fake${i}`
    }));
    await bad({ name: "x", members: many });
  });

  it("rejects bad advance settings (mode, pattern, timeouts, delay)", async () => {
    const adv = (advance: any) => bad({ name: "x", members: [member(main)], advance });
    await adv({ mode: "regex" });
    await adv({ pattern: "" });
    await adv({ pattern: "a".repeat(201) });
    await adv({ pattern: "a*b*c*d*e*f*g" });
    await adv({ startTimeoutSec: 4 });
    await adv({ startTimeoutSec: 3601 });
    await adv({ stopTimeoutSec: 4 });
    await adv({ stopTimeoutSec: 3601 });
    await adv({ mode: "delay", delaySec: 100, startTimeoutSec: 50 });
    await adv("x");
  });

  it("stores regex-looking patterns as literal text", async () => {
    const g = await createGroup("u1", {
      name: "literal",
      members: [member(main)],
      advance: { pattern: "(.+)+$" }
    });
    expect(g.advance.pattern).toBe("(.+)+$");
    await grp("u1", "DELETE", "/delete", { query: { id: g.uuid } });
  });

  it("ignores client supplied owner, id and display data", async () => {
    const g = await createGroup("u1", {
      name: "forge",
      uuid: "forged-id",
      ownerUuid: world.u2.uuid,
      members: [{ ...member(main), nickname: "FORGED", status: 3, available: true }]
    });
    expect(g.uuid).not.toBe("forged-id");
    expect(g.members[0].nickname).not.toBe("FORGED");
    expect(g.members[0].status).toBe(0);
    expect((await listOf("u2")).map((x) => x.uuid)).not.toContain(g.uuid);
    await grp("u1", "DELETE", "/delete", { query: { id: g.uuid } });
  });

  it("enforces the limit of 20 groups per user", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const g = await createGroup("u2", { name: `g${i}`, members: [] });
      ids.push(g.uuid);
    }
    const r = await grp("u2", "POST", "/create", { body: { name: "21st", members: [] } });
    expect(r.httpStatus).toBe(400);
    expect(await listOf("u2")).toHaveLength(20);
    for (const id of ids) await grp("u2", "DELETE", "/delete", { query: { id } });
    expect(await listOf("u2")).toHaveLength(0);
  });
});

describe("instance groups: ownership isolation", () => {
  let groupId = "";

  it("user B gets not-found for update and delete of user A's group, and it is untouched", async () => {
    const g = await createGroup("u1", { name: "Private", members: [member(main)] });
    groupId = g.uuid;

    expect((await listOf("u2")).map((x) => x.uuid)).not.toContain(groupId);

    const upd = await grp("u2", "PUT", "/update", {
      query: { id: groupId },
      body: { name: "hacked" }
    });
    expect(upd.httpStatus).toBe(404);
    const del = await grp("u2", "DELETE", "/delete", { query: { id: groupId } });
    expect(del.httpStatus).toBe(404);

    // Even an administrator is only the owner of their own groups
    const admUpd = await grp("admin", "PUT", "/update", {
      query: { id: groupId },
      body: { name: "hacked" }
    });
    expect(admUpd.httpStatus).toBe(404);
    const admDel = await grp("admin", "DELETE", "/delete", { query: { id: groupId } });
    expect(admDel.httpStatus).toBe(404);

    const [mine] = (await listOf("u1")).filter((x) => x.uuid === groupId);
    expect(mine.name).toBe("Private");
  });

  it("unassigning an instance later makes the member unavailable with no name or status", async () => {
    const g = await createGroup("admin", { name: "tmp", members: [member(main)] });
    await grp("admin", "DELETE", "/delete", { query: { id: g.uuid } });

    // u1 owns a group holding main + third; then an admin unassigns third
    await assignToU1([main, third]);
    const mixed = await createGroup("u1", {
      name: "Mixed",
      members: [member(main), member(third)]
    });
    expect(mixed.members.every((m: any) => m.available)).toBe(true);

    await assignToU1([main]);
    const [after] = (await listOf("u1")).filter((x) => x.uuid === mixed.uuid);
    const thirdView = after.members.find((m: any) => m.instanceUuid === third);
    expect(thirdView).toEqual({ daemonId: di(), instanceUuid: third, available: false });
    expect(thirdView.nickname).toBeUndefined();
    expect(thirdView.status).toBeUndefined();
    const mainView = after.members.find((m: any) => m.instanceUuid === main);
    expect(mainView).toMatchObject({ available: true, status: 0 });

    await grp("u1", "DELETE", "/delete", { query: { id: mixed.uuid } });
    await grp("u1", "DELETE", "/delete", { query: { id: groupId } });
  });
});

// ---------------------------------------------------------------------------
// Real-daemon runs. Every instance runs a tiny harmless Node script that prints a
// Minecraft-like `Done (0.1s)!` line after a delay (or never), keeps running until
// it reads `exit` on stdin, and records timestamps in its working directory.
// ---------------------------------------------------------------------------

const READY_SCRIPT = `
import fs from "node:fs";
import readline from "node:readline";
const readyDelay = Number(process.argv[2] ?? 100);
const stopDelay = Number(process.argv[3] ?? 200);
const stamp = (file) => fs.writeFileSync(file, String(Date.now()));
stamp("started.txt");
console.log("Starting test server...");
if (readyDelay >= 0) {
  setTimeout(() => {
    stamp("ready.txt");
    console.log('[Server thread/INFO]: Done (0.1s)! For help, type "help"');
  }, readyDelay);
}
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim() === "exit") {
    stamp("stopcmd.txt");
    setTimeout(() => {
      stamp("stopped.txt");
      process.exit(0);
    }, stopDelay);
  }
});
setInterval(() => {}, 1000);
`;

const scriptPath = path.join(os.tmpdir(), `mcsm-it-ready-${process.pid}.mjs`);
const assigned: string[] = [];
const made: string[] = [];

// Admin-level status (works for instances that are not assigned to anyone)
async function statusOf(uuid: string): Promise<number> {
  const r = await requestPanel({
    method: "GET",
    path: "/instance",
    ...adm(),
    query: { daemonId: di(), uuid }
  });
  return r?.data?.status ?? -99;
}

async function stopAsAdmin(uuid: string) {
  // A stop sent while the instance is still STARTING (the daemon guards the first 2 seconds of a
  // start) is refused, so wait for a settled state first.
  await waitFor(async () => [RUNNING, STOPPED].includes(await statusOf(uuid)), {
    timeout: 20000,
    interval: 300,
    msg: `instance ${uuid} settled`
  });
  if ((await statusOf(uuid)) === STOPPED) return;
  await requestPanel({
    method: "GET",
    path: "/protected_instance/stop",
    ...adm(),
    query: { daemonId: di(), uuid }
  });
  await waitFor(async () => (await statusOf(uuid)) === STOPPED, {
    timeout: 40000,
    interval: 500,
    msg: `instance ${uuid} stopped`
  });
}

// Create an instance running the ready script and (optionally) assign it to u1
async function makeNode(
  name: string,
  opts: { readyDelayMs?: number; stopDelayMs?: number; assign?: boolean } = {}
): Promise<string> {
  const ready = opts.readyDelayMs ?? 700;
  const stop = opts.stopDelayMs ?? 400;
  const uuid = await createInstance(name, { startCommand: `node ready.mjs ${ready} ${stop}` });
  made.push(uuid);
  if (opts.assign !== false) {
    assigned.push(uuid);
    await assignToU1([world.instance.uuid!, ...assigned]);
  }
  // upload with an admin session (valid for every instance, assigned or not)
  const pp = await getUploadPassport(di(), uuid, adm().cookie, adm().token, ".");
  const up = await uploadToDaemon(pp, scriptPath, "ready.mjs", { unzip: false });
  expect(up.httpStatus, `upload ready.mjs: ${JSON.stringify(up.data).slice(0, 160)}`).toBe(200);
  return uuid;
}

async function readStamp(uuid: string, file: string): Promise<number> {
  const r = await readFileText(di(), uuid, adm().cookie, adm().token, file);
  const n = Number(String(r.data).trim());
  expect(
    Number.isFinite(n),
    `stamp ${file} of ${uuid}: ${JSON.stringify(r.raw).slice(0, 120)}`
  ).toBe(true);
  return n;
}

async function runOf(who: Who, groupId: string): Promise<any> {
  const r = await grp(who, "GET", "/run", { query: { id: groupId } });
  expect(r.httpStatus, JSON.stringify(r.raw).slice(0, 200)).toBe(200);
  return r.data.run;
}

async function waitRun(who: Who, groupId: string, pred: (run: any) => boolean, timeout = 120000) {
  let last: any;
  await waitFor(
    async () => {
      last = await runOf(who, groupId);
      return last && pred(last);
    },
    { timeout, interval: 500, msg: `run condition (last=${JSON.stringify(last)?.slice(0, 300)})` }
  );
  return last;
}

const isFinished = (run: any) => run.state !== "running";

describe("instance groups: real daemon runs", () => {
  it("prepares the ready script", () => {
    fs.writeFileSync(scriptPath, READY_SCRIPT);
  });

  it("starts in start order waiting for the ready line, and stops in the (different) stop order", async () => {
    const lobby = await makeNode("mcsm-it-lobby");
    const main = await makeNode("mcsm-it-main");
    const velocity = await makeNode("mcsm-it-velocity");

    const g = await createGroup("u1", {
      name: "Network",
      members: [member(lobby), member(main), member(velocity)],
      stopOrder: [velocity, main, lobby].map((id) => `${di()}::${id}`)
    });

    const start = await grp("u1", "POST", "/start", { query: { id: g.uuid } });
    expect(start.httpStatus, JSON.stringify(start.raw).slice(0, 200)).toBe(200);
    expect(start.data.runId).toBeTruthy();

    const done = await waitRun("u1", g.uuid, isFinished);
    expect(done.state, JSON.stringify(done)).toBe("succeeded");
    expect(done.steps.map((x: any) => x.state)).toEqual(["done", "done", "done"]);
    for (const id of [lobby, main, velocity]) expect(await statusOf(id)).toBe(RUNNING);

    const t = [
      await readStamp(lobby, "started.txt"),
      await readStamp(main, "started.txt"),
      await readStamp(velocity, "started.txt")
    ];
    expect(t[0]).toBeLessThan(t[1]);
    expect(t[1]).toBeLessThan(t[2]);
    // each member only started after the previous one printed its ready line (ordering of the
    // recorded timestamps, not an absolute gap)
    expect(t[1]).toBeGreaterThanOrEqual(await readStamp(lobby, "ready.txt"));
    expect(t[2]).toBeGreaterThanOrEqual(await readStamp(main, "ready.txt"));

    const stop = await grp("u1", "POST", "/stop", { query: { id: g.uuid } });
    expect(stop.httpStatus, JSON.stringify(stop.raw).slice(0, 200)).toBe(200);
    const stopped = await waitRun("u1", g.uuid, isFinished);
    expect(stopped.state, JSON.stringify(stopped)).toBe("succeeded");
    expect(stopped.action).toBe("stop");
    expect(stopped.steps.map((x: any) => x.key)).toEqual(
      [velocity, main, lobby].map((id) => `${di()}::${id}`)
    );
    for (const id of [lobby, main, velocity]) expect(await statusOf(id)).toBe(STOPPED);

    // Stop order: velocity, then main (only after velocity fully exited), then lobby
    const cmd = {
      velocity: await readStamp(velocity, "stopcmd.txt"),
      main: await readStamp(main, "stopcmd.txt"),
      lobby: await readStamp(lobby, "stopcmd.txt")
    };
    const exited = {
      velocity: await readStamp(velocity, "stopped.txt"),
      main: await readStamp(main, "stopped.txt")
    };
    expect(cmd.velocity).toBeLessThan(cmd.main);
    expect(cmd.main).toBeLessThan(cmd.lobby);
    expect(cmd.main).toBeGreaterThanOrEqual(exited.velocity);
    expect(cmd.lobby).toBeGreaterThanOrEqual(exited.main);

    // the finished run stays readable, and the list carries it
    const listed = (await listOf("u1")).find((x) => x.uuid === g.uuid);
    expect(listed.run).toMatchObject({ action: "stop", state: "succeeded" });
    await grp("u1", "DELETE", "/delete", { query: { id: g.uuid } });
  });

  it("a never-ready member fails with timeout (minimum timeout) and later members stay stopped", async () => {
    const a = await makeNode("mcsm-it-ok-a");
    const b = await makeNode("mcsm-it-never", { readyDelayMs: -1 });
    const c = await makeNode("mcsm-it-ok-c");
    const g = await createGroup("u1", {
      name: "Timeout",
      members: [member(a), member(b), member(c)],
      advance: { startTimeoutSec: 5 }
    });
    const t0 = Date.now();
    expect((await grp("u1", "POST", "/start", { query: { id: g.uuid } })).httpStatus).toBe(200);
    const run = await waitRun("u1", g.uuid, isFinished);
    expect(run.state).toBe("failed");
    expect(run.steps.map((x: any) => [x.state, x.reason])).toEqual([
      ["done", undefined],
      ["failed", "timeout"],
      ["pending", undefined]
    ]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5000);
    expect(await statusOf(c)).toBe(STOPPED);
    // no automatic kill: the never-ready instance is still running
    expect(await statusOf(b)).toBe(RUNNING);

    await stopAsAdmin(a);
    await stopAsAdmin(b);
    await grp("u1", "DELETE", "/delete", { query: { id: g.uuid } });
  });

  it("an instance unassigned after the group was created is not touched; the run fails not_permitted", async () => {
    const a = await makeNode("mcsm-it-perm-a");
    const gone = await makeNode("mcsm-it-perm-gone");
    const z = await makeNode("mcsm-it-perm-z");
    const g = await createGroup("u1", {
      name: "Perm",
      members: [member(a), member(gone), member(z)]
    });
    // admin unassigns the middle instance
    assigned.splice(assigned.indexOf(gone), 1);
    await assignToU1([world.instance.uuid!, ...assigned]);

    // the listing already hides it
    const listed = (await listOf("u1")).find((x) => x.uuid === g.uuid);
    expect(listed.members[1]).toEqual({ daemonId: di(), instanceUuid: gone, available: false });

    expect((await grp("u1", "POST", "/start", { query: { id: g.uuid } })).httpStatus).toBe(200);
    const run = await waitRun("u1", g.uuid, isFinished);
    expect(run.state).toBe("failed");
    expect(run.steps.map((x: any) => [x.state, x.reason])).toEqual([
      ["done", undefined],
      ["failed", "not_permitted"],
      ["pending", undefined]
    ]);
    expect(await statusOf(gone)).toBe(STOPPED);
    expect(await statusOf(z)).toBe(STOPPED);

    await stopAsAdmin(a);
    await grp("u1", "DELETE", "/delete", { query: { id: g.uuid } });
  });

  it("a second start gets 409 while a run is active; changes are refused; cancel works", async () => {
    const slow = await makeNode("mcsm-it-cancel-slow", { readyDelayMs: -1 });
    const after = await makeNode("mcsm-it-cancel-after");
    const g = await createGroup("u1", { name: "Cancel", members: [member(slow), member(after)] });

    expect((await grp("u1", "POST", "/start", { query: { id: g.uuid } })).httpStatus).toBe(200);
    await waitRun("u1", g.uuid, (r) => r.steps[0].state === "waiting");

    expect((await grp("u1", "POST", "/start", { query: { id: g.uuid } })).httpStatus).toBe(409);
    expect((await grp("u1", "POST", "/stop", { query: { id: g.uuid } })).httpStatus).toBe(409);
    expect(
      (
        await grp("u1", "PUT", "/update", {
          query: { id: g.uuid },
          body: { members: [member(slow)] }
        })
      ).httpStatus
    ).toBe(409);
    expect((await grp("u1", "DELETE", "/delete", { query: { id: g.uuid } })).httpStatus).toBe(409);

    const cancel = await grp("u1", "POST", "/cancel", { query: { id: g.uuid } });
    expect(cancel.httpStatus, JSON.stringify(cancel.raw).slice(0, 200)).toBe(200);
    expect(cancel.data.run.state).toBe("cancelled");
    expect(cancel.data.run.steps.map((x: any) => x.state)).toEqual(["failed", "pending"]);
    expect((await runOf("u1", g.uuid)).state).toBe("cancelled");
    // the member after the cancelled one was never started
    expect(await statusOf(after)).toBe(STOPPED);
    // cancelling again: nothing is active
    expect((await grp("u1", "POST", "/cancel", { query: { id: g.uuid } })).httpStatus).toBe(409);

    await stopAsAdmin(slow);
    expect((await grp("u1", "DELETE", "/delete", { query: { id: g.uuid } })).httpStatus).toBe(200);
  });

  it("another user cannot start, stop, cancel or read the run of someone else's group", async () => {
    const n = await makeNode("mcsm-it-foreign");
    const g = await createGroup("u1", { name: "Foreign", members: [member(n)] });
    for (const [method, p] of [
      ["POST", "/start"],
      ["POST", "/stop"],
      ["POST", "/cancel"],
      ["GET", "/run"]
    ] as const) {
      for (const who of ["u2", "admin"] as const) {
        const r = await grp(who, method, p, { query: { id: g.uuid } });
        expect(r.httpStatus, `${who} ${method} ${p}`).toBe(404);
      }
    }
    expect(await statusOf(n)).toBe(STOPPED);
    expect(await runOf("u1", g.uuid)).toBeNull();
    await grp("u1", "DELETE", "/delete", { query: { id: g.uuid } });
  });

  it("start ignores a request body listing other instances", async () => {
    const mine = await makeNode("mcsm-it-body-mine");
    const other2 = await makeNode("mcsm-it-body-other", { assign: false });
    const g = await createGroup("u1", { name: "Body", members: [member(mine)] });
    const r = await grp("u1", "POST", "/start", {
      query: { id: g.uuid },
      body: { members: [member(other2)], instanceUuids: [other2] }
    });
    expect(r.httpStatus).toBe(200);
    const run = await waitRun("u1", g.uuid, isFinished);
    expect(run.state).toBe("succeeded");
    expect(run.steps).toHaveLength(1);
    expect(await statusOf(other2)).toBe(STOPPED);
    await stopAsAdmin(mine);
    await grp("u1", "DELETE", "/delete", { query: { id: g.uuid } });
  });

  it("cleans up the temporary script", () => {
    fs.rmSync(scriptPath, { force: true });
    void u1;
  });
});
