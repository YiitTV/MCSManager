import { describe, expect, it } from "vitest";
import {
  BACKUP_DEFAULT_EXCLUDES,
  BACKUP_LIMITS,
  BACKUP_PART_SIZES,
  BACKUP_PRESETS,
  BACKUP_PROTOCOL,
  BACKUP_SECRET_MASK,
  BackupDriverError,
  BackupDriverErrorCode,
  BackupRecord,
  buildBackupFileName,
  buildBackupObjectName,
  buildReadableBackupFileName,
  backupScheduleName,
  chooseS3PartSize,
  expandBackupPreset,
  isMaskedSecret,
  isValidBackupId,
  redactRecordForUser,
  sanitizeBackupError,
  sanitizeBackupInstanceName,
  stripSecrets,
  validateExcludeGlobs,
  validateIncludePaths,
  EncryptedSecret,
  S3Destination,
  StoredBackupDestination,
  PlainBackupDestination
} from "../index";

const s3Plain: PlainBackupDestination = {
  id: "d1",
  type: "s3",
  name: "bucket",
  config: {
    endpoint: "https://s3.example.com",
    region: "us-east-1",
    bucket: "my-bucket",
    pathStyle: true,
    allowPrivateNetwork: false,
    accessKeyId: "AKIAEXAMPLE"
  },
  secrets: { secretAccessKey: "super-secret-value" },
  createdAt: 1,
  updatedAt: 2
};

describe("constants", () => {
  it("matches the design limits", () => {
    expect(BACKUP_LIMITS.MAX_DESTINATIONS).toBe(20);
    expect(BACKUP_LIMITS.MAX_PLANS_PER_INSTANCE).toBe(4);
    expect(BACKUP_LIMITS.MAX_RECORDS_PER_INSTANCE).toBe(500);
    expect(BACKUP_LIMITS.QUEUE_LIMIT).toBe(20);
    expect([BACKUP_LIMITS.MIN_RETENTION, BACKUP_LIMITS.MAX_RETENTION]).toEqual([1, 100]);
    expect(BACKUP_PART_SIZES.GDRIVE_CHUNK % (256 * 1024)).toBe(0);
    expect(BACKUP_SECRET_MASK).toBe("__MCSM_SECRET_DATA__");
  });

  it("protocol event names are unique and prefixed", () => {
    const names = Object.values(BACKUP_PROTOCOL);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.startsWith("backup/")).toBe(true);
  });

  it("schedule name uses the first 8 chars of the plan id", () => {
    expect(backupScheduleName("abcdef123456")).toBe("backup-abcdef12");
  });
});

describe("presets", () => {
  it("every preset passes the validators", () => {
    for (const def of Object.values(BACKUP_PRESETS)) {
      expect(validateIncludePaths([...def.include]).ok).toBe(true);
      expect(validateExcludeGlobs([...def.exclude]).ok).toBe(true);
    }
    expect(validateExcludeGlobs([...BACKUP_DEFAULT_EXCLUDES]).ok).toBe(true);
  });

  it("expands as the spec says", () => {
    expect(expandBackupPreset("minecraft-worlds").include).toEqual([
      "world",
      "world_nether",
      "world_the_end"
    ]);
    expect(expandBackupPreset("minecraft-worlds-plugins-configs").include).toEqual([
      "world",
      "world_nether",
      "world_the_end",
      "plugins",
      "config",
      "server.properties",
      "ops.json",
      "whitelist.json",
      "bukkit.yml",
      "spigot.yml"
    ]);
    expect(expandBackupPreset("whole-directory").include).toEqual(["."]);
    expect(expandBackupPreset("minecraft-worlds").exclude).toEqual([...BACKUP_DEFAULT_EXCLUDES]);
  });

  it("custom keeps supplied lists and copies them", () => {
    const include = ["a"];
    const r = expandBackupPreset("custom", { include, exclude: ["b"] });
    expect(r).toEqual({ include: ["a"], exclude: ["b"] });
    expect(r.include).not.toBe(include);
    expect(expandBackupPreset("custom")).toEqual({ include: [], exclude: [] });
  });

  it("expansion does not alias the preset constants", () => {
    const r = expandBackupPreset("minecraft-worlds");
    r.include.push("x");
    expect(BACKUP_PRESETS["minecraft-worlds"].include).not.toContain("x");
  });
});

describe("stripSecrets", () => {
  it("masks present plain secrets and keeps config", () => {
    const out = stripSecrets(s3Plain);
    expect((out as S3Destination).secrets.secretAccessKey).toBe(BACKUP_SECRET_MASK);
    expect(out.config).toEqual(s3Plain.config);
    expect(JSON.stringify(out)).not.toContain("super-secret-value");
  });

  it("masks encrypted secrets and leaves empty ones empty", () => {
    const enc: EncryptedSecret = { iv: "a", tag: "b", ciphertext: "c" };
    const stored: StoredBackupDestination = {
      id: "g1",
      type: "gdrive",
      name: "drive",
      config: { authMethod: "oauth", clientId: "client-id-123" },
      secrets: { clientSecret: enc, refreshToken: undefined },
      createdAt: 1,
      updatedAt: 1
    };
    const out = stripSecrets(stored) as any;
    expect(out.secrets.clientSecret).toBe(BACKUP_SECRET_MASK);
    expect(out.secrets.refreshToken).toBe("");
    expect(JSON.stringify(out)).not.toContain("ciphertext");
  });

  it("does not mutate the input and handles missing secrets", () => {
    const copy = JSON.parse(JSON.stringify(s3Plain));
    stripSecrets(s3Plain);
    expect(s3Plain).toEqual(copy);
    const local = stripSecrets({
      id: "l",
      type: "local",
      name: "x",
      config: { directory: "/b", maxTotalBytes: 1 },
      secrets: {},
      createdAt: 0,
      updatedAt: 0
    });
    expect(local.secrets).toEqual({});
  });

  it("isMaskedSecret", () => {
    expect(isMaskedSecret(BACKUP_SECRET_MASK)).toBe(true);
    expect(isMaskedSecret("x")).toBe(false);
  });
});

describe("ids and names", () => {
  it("validates ids", () => {
    expect(isValidBackupId("abc-DEF_12")).toBe(true);
    for (const bad of ["", "a/b", "../x", "a b", "a".repeat(65), 5, null, "a.b"]) {
      expect(isValidBackupId(bad)).toBe(false);
    }
  });

  it("builds object and file names only from valid ids", () => {
    expect(buildBackupObjectName({ instanceUuid: "i", planId: "p", backupId: "b" })).toBe(
      "i/p/b.zip"
    );
    expect(buildBackupFileName("p", "b")).toBe("p_b.zip");
    expect(() =>
      buildBackupObjectName({ instanceUuid: "../x", planId: "p", backupId: "b" })
    ).toThrow();
    expect(() => buildBackupFileName("p", "b/c")).toThrow();
  });

  it.each([
    ["  Çığ Şöléni İÜ-12_v.2  ", "Çığ Şöléni İÜ-12_v.2"],
    ["../a\\b/🎮", ".._a_b__"],
    ["..", "instance"],
    [".", "instance"],
    ["   ", "instance"],
    [undefined, "instance"],
    ["a".repeat(61), "a".repeat(60)],
    ["NUL.server", "_NUL.server"]
  ])("sanitizes %s to %s", (name, expected) => {
    expect(sanitizeBackupInstanceName(name, "instance123")).toBe(expected);
  });

  it("builds a readable name using UTC minutes and the backup id prefix", () => {
    const object = { instanceUuid: "instance123", planId: "p", backupId: "2c2ff8-123" };
    expect(buildReadableBackupFileName(object)).toBe("p_2c2ff8-123.zip");
    expect(
      buildReadableBackupFileName({
        ...object,
        instanceName: "Lobi",
        createdAt: Date.parse("2026-11-19T19:00:59+03:00")
      })
    ).toBe("Lobi_2026-11-19_16-00_2c2ff8.zip");
    const maxWidthName = buildReadableBackupFileName({
      ...object,
      instanceName: "𐐀".repeat(60),
      createdAt: 0
    });
    expect(maxWidthName).toBe(`${"𐐀".repeat(56)}_1970-01-01_00-00_2c2ff8.zip`);
  });
});

describe("chooseS3PartSize", () => {
  it("uses 8 MiB up to 10000 parts then 16 MiB", () => {
    expect(chooseS3PartSize(1)).toBe(8 * 1024 * 1024);
    expect(chooseS3PartSize(8 * 1024 * 1024 * 10000)).toBe(8 * 1024 * 1024);
    expect(chooseS3PartSize(8 * 1024 * 1024 * 10000 + 1)).toBe(16 * 1024 * 1024);
  });
});

describe("redactRecordForUser", () => {
  it("drops remote ids", () => {
    const record: BackupRecord = {
      id: "b",
      planId: "p",
      createdAt: 1,
      sizeBytes: 2,
      sha256: "0".repeat(64),
      trigger: "manual",
      warnings: [],
      copies: { d: { status: "ok", type: "s3", name: "n", remoteId: "key/secret/path" } }
    };
    const out = redactRecordForUser(record);
    expect(JSON.stringify(out)).not.toContain("key/secret/path");
    expect(out.copies.d.status).toBe("ok");
    expect(record.copies.d.remoteId).toBe("key/secret/path");
  });
});

describe("sanitizeBackupError", () => {
  it("removes secrets, urls and auth values", () => {
    const err = new Error(
      "PUT https://s3.example.com/bucket/key?X-Amz-Signature=abc failed: Authorization: AWS4-HMAC-SHA256 Credential=XYZ, secret=hunter2hunter2 token abc"
    );
    const out = sanitizeBackupError(err, ["hunter2hunter2"]);
    expect(out).not.toContain("https://");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("AWS4-HMAC");
  });

  it("redacts bearer tokens, long runs, controls and truncates", () => {
    expect(sanitizeBackupError("Bearer ya29.abcdef")).toBe("Bearer ***");
    expect(sanitizeBackupError("x " + "A".repeat(60))).toBe("x ***");
    expect(sanitizeBackupError("a\u0000b\nc")).toBe("a b c");
    expect(sanitizeBackupError("e".repeat(1000)).length).toBeLessThanOrEqual(300);
    expect(sanitizeBackupError(undefined)).toBe("");
  });
});

describe("BackupDriverError", () => {
  it("is retryable only when transient by default", () => {
    expect(new BackupDriverError(BackupDriverErrorCode.TRANSIENT, "x").retryable).toBe(true);
    expect(new BackupDriverError(BackupDriverErrorCode.AUTH, "x").retryable).toBe(false);
    const e = new BackupDriverError(BackupDriverErrorCode.FAILED, "x");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BackupDriverError");
  });
});
