import fs from "fs-extra";
import os from "node:os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKUP_SECRET_MASK, backupScheduleName } from "mcsmanager-common";
import { fakeDaemon, memoryStore } from "./fake_daemon";

vi.mock(
  "../../common/storage/sys_storage",
  async () => (await import("./fake_daemon")).sysStorageMock
);
vi.mock("../remote_command", async () => (await import("./fake_daemon")).remoteCommandMock);
vi.mock("../remote_service", async () => (await import("./fake_daemon")).remoteServiceMock);
vi.mock("../log", async () => (await import("./fake_daemon")).logMock);

import { setBackupSecretKeyFileForTest } from "../backup_secret";
import {
  BackupServiceError,
  createDestination,
  createPlan,
  deleteDestination,
  deletePlan,
  listPlansForInstance,
  listPublicDestinations,
  getStoredDestination,
  updateDestination,
  updatePlan,
  toPlainDestination
} from "../backup_service";

let dir = "";
const S3 = (over: any = {}) => ({
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
  secrets: { secretAccessKey: "SUPER-SECRET-KEY-VALUE" },
  ...over
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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bk-svc-"));
  setBackupSecretKeyFileForTest(path.join(dir, "key"));
  memoryStore.clear();
  fakeDaemon.reset();
  fakeDaemon.on("instance/detail", () => ({ status: 0 }));
  fakeDaemon.on("schedule/delete", () => true);
  fakeDaemon.on("schedule/register", () => true);
});
afterEach(() => {
  setBackupSecretKeyFileForTest(null);
  fs.removeSync(dir);
});

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (e: any) {
    return e instanceof BackupServiceError ? [e.code, e.status, e.params] : e;
  }
  return "no error";
}

describe("destinations", () => {
  it("creates a default local destination and lists it masked", async () => {
    const list = await listPublicDestinations();
    expect(list.map((d) => d.id)).toEqual(["local"]);
    expect(path.isAbsolute((list[0].config as any).directory)).toBe(true);
  });

  it("encrypts secrets at rest and masks them in the public view", async () => {
    const pub = await createDestination(S3());
    const raw = JSON.stringify([...memoryStore.values()]);
    expect(raw).not.toContain("SUPER-SECRET-KEY-VALUE");
    expect((pub.secrets as any).secretAccessKey).toBe(BACKUP_SECRET_MASK);
    const stored = (await getStoredDestination(pub.id))!;
    expect(toPlainDestination(stored).secrets).toEqual({
      secretAccessKey: "SUPER-SECRET-KEY-VALUE"
    });
  });

  it("masked secret on update keeps the stored secret; new value replaces it", async () => {
    const pub = await createDestination(S3());
    await updateDestination({
      ...S3({ name: "Renamed" }),
      id: pub.id,
      secrets: { secretAccessKey: BACKUP_SECRET_MASK }
    });
    let plain = toPlainDestination((await getStoredDestination(pub.id))!);
    expect(plain.name).toBe("Renamed");
    expect((plain.secrets as any).secretAccessKey).toBe("SUPER-SECRET-KEY-VALUE");
    // key omitted entirely also keeps it
    await updateDestination({ ...S3(), id: pub.id, secrets: {} });
    plain = toPlainDestination((await getStoredDestination(pub.id))!);
    expect((plain.secrets as any).secretAccessKey).toBe("SUPER-SECRET-KEY-VALUE");
    await updateDestination({ ...S3(), id: pub.id, secrets: { secretAccessKey: "NEW-VALUE-123" } });
    plain = toPlainDestination((await getStoredDestination(pub.id))!);
    expect((plain.secrets as any).secretAccessKey).toBe("NEW-VALUE-123");
  });

  it("rejects masked secrets on create, bad endpoints and type changes", async () => {
    expect(
      (await code(createDestination(S3({ secrets: { secretAccessKey: BACKUP_SECRET_MASK } }))))[0]
    ).toBe("VALIDATION");
    expect(
      (
        await code(
          createDestination(S3({ config: { ...S3().config, endpoint: "https://u:p@x.com" } }))
        )
      )[0]
    ).toBe("VALIDATION");
    const pub = await createDestination(S3());
    expect((await code(updateDestination({ ...S3(), id: pub.id, type: "local" })))[0]).toBe(
      "DESTINATION_TYPE_IMMUTABLE"
    );
  });

  it("ignores unknown config fields", async () => {
    const pub = await createDestination(S3({ config: { ...S3().config, evil: "<script>" } }));
    expect(JSON.stringify(pub)).not.toContain("evil");
  });

  it("enforces the destination limit", async () => {
    for (let i = 0; i < 19; i++) await createDestination(S3({ name: `d${i}` }));
    expect((await code(createDestination(S3({ name: "over" }))))[0]).toBe("DESTINATION_LIMIT");
  });

  it("refuses deleting a destination in use and the default one", async () => {
    const pub = await createDestination(S3());
    await createPlan(planBody({ destinationIds: [pub.id] }));
    expect(await code(deleteDestination(pub.id))).toEqual([
      "DESTINATION_IN_USE",
      409,
      { count: 1 }
    ]);
    expect((await code(deleteDestination("local")))[0]).toBe("DESTINATION_DEFAULT_PROTECTED");
    const free = await createDestination(S3({ name: "free" }));
    await deleteDestination(free.id);
    expect(await getStoredDestination(free.id)).toBeNull();
  });

  it("drops the refresh token when the OAuth client changes", async () => {
    const pub = await createDestination({
      type: "gdrive",
      name: "Drive",
      config: {
        authMethod: "oauth",
        clientId: "client-id-1.apps.example",
        redirectBaseUrl: "https://panel.example.com"
      },
      secrets: { clientSecret: "gsecret-123" }
    });
    const stored = (await getStoredDestination(pub.id))! as any;
    const { encryptSecret } = await import("../backup_secret");
    stored.secrets.refreshToken = encryptSecret("rt-1");
    memoryStore.set(`BackupDestination/${pub.id}`, { record: [stored] });
    await updateDestination({
      id: pub.id,
      type: "gdrive",
      name: "Drive2",
      config: {
        authMethod: "oauth",
        clientId: "client-id-1.apps.example",
        redirectBaseUrl: "https://panel.example.com"
      },
      secrets: { clientSecret: BACKUP_SECRET_MASK }
    });
    expect(
      (toPlainDestination((await getStoredDestination(pub.id))!).secrets as any).refreshToken
    ).toBe("rt-1");
    await updateDestination({
      id: pub.id,
      type: "gdrive",
      name: "Drive2",
      config: { authMethod: "oauth", clientId: "other-client.apps.example" },
      secrets: { clientSecret: "new-secret-xyz" }
    });
    expect(
      (toPlainDestination((await getStoredDestination(pub.id))!).secrets as any).refreshToken
    ).toBeUndefined();
  });

  it("validates redirectBaseUrl and never accepts a client-sent refresh token", async () => {
    const base = {
      type: "gdrive",
      name: "Drive",
      secrets: { clientSecret: "gsecret-123", refreshToken: "client-supplied" }
    };
    const bad = await code(
      createDestination({
        ...base,
        config: {
          authMethod: "oauth",
          clientId: "client-id-1.apps.example",
          redirectBaseUrl: "http://evil.example.com"
        }
      })
    );
    expect(bad[0]).toBe("VALIDATION");
    const ok = await createDestination({
      ...base,
      config: {
        authMethod: "oauth",
        clientId: "client-id-1.apps.example",
        redirectBaseUrl: "https://panel.example.com/sub"
      }
    });
    expect(
      (toPlainDestination((await getStoredDestination(ok.id))!).secrets as any).refreshToken
    ).toBeUndefined();
  });
});

describe("plans", () => {
  it("expands presets and stores the plan", async () => {
    const plan = await createPlan(planBody());
    expect(plan.include).toEqual(["world", "world_nether", "world_the_end"]);
    expect(plan.exclude).toContain("session.lock");
    expect((await listPlansForInstance("d1", "inst1")).map((p) => p.id)).toEqual([plan.id]);
  });

  it("limits to 4 plans per instance and validates input", async () => {
    for (let i = 0; i < 4; i++) await createPlan(planBody({ name: `p${i}` }));
    expect((await code(createPlan(planBody({ name: "p5" }))))[0]).toBe("PLAN_LIMIT");
    expect((await code(createPlan(planBody({ uuid: "other", retention: 0 }))))[0]).toBe(
      "VALIDATION"
    );
    expect((await code(createPlan(planBody({ uuid: "other", retention: 101 }))))[0]).toBe(
      "VALIDATION"
    );
    expect(
      (
        await code(createPlan(planBody({ uuid: "other", preset: "custom", include: ["../etc"] })))
      )[0]
    ).toBe("VALIDATION");
    expect(
      (await code(createPlan(planBody({ uuid: "other", preset: "custom", include: ["/etc"] }))))[0]
    ).toBe("VALIDATION");
    expect((await code(createPlan(planBody({ uuid: "other", destinationIds: ["nope"] }))))[0]).toBe(
      "DESTINATION_NOT_FOUND"
    );
  });

  it("registers a daemon schedule with one backup action and updates/removes it", async () => {
    const plan = await createPlan(planBody({ schedule: { kind: "interval", value: "3600" } }));
    const name = backupScheduleName(plan.id);
    const reg = fakeDaemon.callsOf("schedule/register");
    expect(reg).toHaveLength(1);
    expect(reg[0].data).toMatchObject({
      instanceUuid: "inst1",
      name,
      count: -1,
      time: "3600",
      type: 1,
      actions: [{ type: "backup", payload: plan.id }]
    });
    await updatePlan({ id: plan.id, schedule: { kind: "cron", value: "0 3 * * *" } });
    expect(fakeDaemon.callsOf("schedule/register")[1].data).toMatchObject({
      type: 2,
      time: "0 3 * * *"
    });
    // disabling removes the schedule
    const before = fakeDaemon.callsOf("schedule/register").length;
    await updatePlan({ id: plan.id, enabled: false });
    expect(fakeDaemon.callsOf("schedule/register")).toHaveLength(before);
    expect(fakeDaemon.callsOf("schedule/delete").at(-1)!.data).toEqual({
      instanceUuid: "inst1",
      name
    });
    await deletePlan(plan.id);
    expect(await listPlansForInstance("d1", "inst1")).toEqual([]);
  });

  it("does not store the plan when the schedule cannot be synced", async () => {
    fakeDaemon.on("schedule/register", () => {
      throw new Error("daemon says no");
    });
    expect(
      (await code(createPlan(planBody({ schedule: { kind: "interval", value: "3600" } }))))[0]
    ).toBe("SCHEDULE_SYNC_FAILED");
    expect(await listPlansForInstance("d1", "inst1")).toEqual([]);
  });

  it("rejects too frequent intervals and unknown daemons/instances", async () => {
    expect(
      (await code(createPlan(planBody({ schedule: { kind: "interval", value: "10" } }))))[0]
    ).toBe("VALIDATION");
    fakeDaemon.on("instance/detail", () => {
      throw new Error("instance missing");
    });
    expect((await code(createPlan(planBody())))[0]).toBe("DAEMON_ERROR");
  });

  it("does not allow moving a plan to another instance", async () => {
    const plan = await createPlan(planBody());
    expect((await code(updatePlan({ id: plan.id, uuid: "other" })))[0]).toBe(
      "PLAN_INSTANCE_IMMUTABLE"
    );
  });
});
