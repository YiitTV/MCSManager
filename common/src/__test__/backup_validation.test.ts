import { describe, expect, it } from "vitest";
import {
  BACKUP_LIMITS,
  BACKUP_SECRET_MASK,
  BackupValidationCode as C,
  checkBackupExcludeGlob,
  checkBackupIncludePath,
  compileExcludeMatcher,
  isValidBackupCron,
  matchGlobSegment,
  normalizeBackupIncludePath,
  validateDestination,
  validateDestinationIds,
  validateExcludeGlobs,
  validateIncludePaths,
  validatePlan,
  validateRetention,
  validateS3Bucket,
  validateS3Endpoint,
  validateS3Prefix,
  validateSchedule,
  validateBackupName
} from "../index";

function code(r: any): string | undefined {
  return r.ok ? undefined : r.code;
}

describe("include paths", () => {
  it.each([
    "world",
    "world_nether",
    "plugins/Foo/data",
    "a b/c",
    "server.properties",
    ".",
    "./",
    "./world",
    "a\\b",
    "a/./b",
    "world/",
    ".hidden",
    "a..b",
    "..a",
    "a.."
  ])("accepts %s", (p) => {
    expect(checkBackupIncludePath(p)).toBeNull();
  });

  it.each([
    ["../x", C.INCLUDE_TRAVERSAL],
    ["..", C.INCLUDE_TRAVERSAL],
    ["a/../../b", C.INCLUDE_TRAVERSAL],
    ["a/..", C.INCLUDE_TRAVERSAL],
    ["a\\..\\b", C.INCLUDE_TRAVERSAL],
    ["./../x", C.INCLUDE_TRAVERSAL],
    ["/etc", C.INCLUDE_ABSOLUTE],
    ["/etc/passwd", C.INCLUDE_ABSOLUTE],
    ["\\windows", C.INCLUDE_ABSOLUTE],
    ["C:\\Windows", C.INCLUDE_ABSOLUTE],
    ["c:/x", C.INCLUDE_ABSOLUTE],
    ["C:x", C.INCLUDE_ABSOLUTE],
    ["\\\\server\\share", C.INCLUDE_ABSOLUTE],
    ["//server/share", C.INCLUDE_ABSOLUTE],
    ["%2e%2e/x", C.INCLUDE_ENCODED_TRAVERSAL],
    ["a/%2E%2E/b", C.INCLUDE_ENCODED_TRAVERSAL],
    ["a%2fb", C.INCLUDE_ENCODED_TRAVERSAL],
    ["a%5Cb", C.INCLUDE_ENCODED_TRAVERSAL],
    ["a\u0000b", C.INCLUDE_CONTROL_CHAR],
    ["a\nb", C.INCLUDE_CONTROL_CHAR],
    ["a\u007fb", C.INCLUDE_CONTROL_CHAR],
    ["", C.INCLUDE_EMPTY],
    ["a".repeat(257), C.INCLUDE_TOO_LONG],
    [Array(40).fill("a").join("/"), C.INCLUDE_TOO_DEEP],
    ["ab:c", C.INCLUDE_ILLEGAL_CHAR],
    ["a:b", C.INCLUDE_ABSOLUTE],
    ["a*b", C.INCLUDE_ILLEGAL_CHAR],
    ["a|b", C.INCLUDE_ILLEGAL_CHAR],
    ["a/.../b", C.INCLUDE_ILLEGAL_SEGMENT],
    ["a/ /b", C.INCLUDE_ILLEGAL_SEGMENT],
    ["//", C.INCLUDE_ABSOLUTE],
    [".//.", C.INCLUDE_ILLEGAL_SEGMENT],
    [5 as any, C.INCLUDE_NOT_STRING],
    [null as any, C.INCLUDE_NOT_STRING]
  ])("rejects %j", (p, expected) => {
    expect(checkBackupIncludePath(p)).toBe(expected);
  });

  it("normalises", () => {
    expect(normalizeBackupIncludePath("./a//b\\c/")).toBe("a/b/c");
    expect(normalizeBackupIncludePath(".")).toBe(".");
    expect(normalizeBackupIncludePath("./")).toBe(".");
    expect(() => normalizeBackupIncludePath("../x")).toThrow();
  });

  it("validates lists", () => {
    expect(validateIncludePaths(["a", "b"]).ok).toBe(true);
    expect(code(validateIncludePaths("a"))).toBe(C.INCLUDE_NOT_ARRAY);
    expect(code(validateIncludePaths([]))).toBe(C.INCLUDE_EMPTY_LIST);
    expect(
      code(
        validateIncludePaths(
          Array(51)
            .fill("a")
            .map((_, i) => `p${i}`)
        )
      )
    ).toBe(C.INCLUDE_TOO_MANY);
    expect(
      validateIncludePaths(
        Array(50)
          .fill("a")
          .map((_, i) => `p${i}`)
      ).ok
    ).toBe(true);
    expect(code(validateIncludePaths(["a", "./a"]))).toBe(C.INCLUDE_DUPLICATE);
    expect(validateIncludePaths(["a", "../b"])).toEqual({
      ok: false,
      code: C.INCLUDE_TRAVERSAL,
      field: "include",
      index: 1
    });
  });
});

describe("exclude globs", () => {
  it.each([
    "*.tmp",
    "logs",
    "cache/",
    "plugins/*.jar",
    "**/node_modules",
    "a/**/b",
    "file?.txt",
    "(1).txt",
    "a/**",
    "**"
  ])("accepts %s", (g) => expect(checkBackupExcludeGlob(g)).toBeNull());

  it.each([
    ["", C.EXCLUDE_EMPTY],
    ["/", C.EXCLUDE_ABSOLUTE],
    ["a".repeat(257), C.EXCLUDE_TOO_LONG],
    [Array(40).fill("a").join("/"), C.EXCLUDE_TOO_DEEP],
    ["a\u0000", C.EXCLUDE_CONTROL_CHAR],
    ["/abs", C.EXCLUDE_ABSOLUTE],
    ["C:/x", C.EXCLUDE_ABSOLUTE],
    ["a\\b", C.EXCLUDE_ABSOLUTE],
    ["../x", C.EXCLUDE_TRAVERSAL],
    ["a/../b", C.EXCLUDE_TRAVERSAL],
    ["a//b", C.EXCLUDE_EMPTY_SEGMENT],
    ["[abc]", C.EXCLUDE_UNSUPPORTED_SYNTAX],
    ["{a,b}", C.EXCLUDE_UNSUPPORTED_SYNTAX],
    ["!keep", C.EXCLUDE_UNSUPPORTED_SYNTAX],
    ["a**b", C.EXCLUDE_UNSUPPORTED_SYNTAX],
    ["***", C.EXCLUDE_UNSUPPORTED_SYNTAX],
    [3 as any, C.EXCLUDE_NOT_STRING]
  ])("rejects %j", (g, expected) => expect(checkBackupExcludeGlob(g)).toBe(expected));

  it("validates lists", () => {
    expect(validateExcludeGlobs([]).ok).toBe(true);
    expect(code(validateExcludeGlobs(undefined))).toBe(C.EXCLUDE_NOT_ARRAY);
    expect(code(validateExcludeGlobs(Array(51).fill("a")))).toBe(C.EXCLUDE_TOO_MANY);
    expect(validateExcludeGlobs(["ok", "[x]"])).toEqual({
      ok: false,
      code: C.EXCLUDE_UNSUPPORTED_SYNTAX,
      field: "exclude",
      index: 1
    });
  });
});

describe("glob matcher", () => {
  it("segment matching", () => {
    expect(matchGlobSegment("*.tmp", "a.tmp")).toBe(true);
    expect(matchGlobSegment("*.tmp", ".tmp")).toBe(true);
    expect(matchGlobSegment("*.tmp", "a.tmpx")).toBe(false);
    expect(matchGlobSegment("a?c", "abc")).toBe(true);
    expect(matchGlobSegment("a?c", "ac")).toBe(false);
    expect(matchGlobSegment("a*b*c", "aXXbYYc")).toBe(true);
    expect(matchGlobSegment("a*b*c", "aXXbYY")).toBe(false);
    expect(matchGlobSegment("*", "")).toBe(true);
    expect(matchGlobSegment("", "")).toBe(true);
    expect(matchGlobSegment("", "a")).toBe(false);
    expect(matchGlobSegment("Abc", "abc")).toBe(false);
  });

  it("unanchored patterns match any depth and ancestors", () => {
    const m = compileExcludeMatcher(["cache", "*.tmp"]);
    expect(m("cache")).toBe(true);
    expect(m("a/cache/x/y")).toBe(true);
    expect(m("a/b.tmp")).toBe(true);
    expect(m("a\\b.tmp")).toBe(true);
    expect(m("a/cachex")).toBe(false);
    expect(m("a/b.txt")).toBe(false);
    expect(m("")).toBe(false);
    expect(m(".")).toBe(false);
  });

  it("anchored patterns", () => {
    const m = compileExcludeMatcher(["plugins/*.jar", "world/region/"]);
    expect(m("plugins/a.jar")).toBe(true);
    expect(m("plugins/sub/a.jar")).toBe(false);
    expect(m("other/plugins/a.jar")).toBe(false);
    expect(m("world/region/r.0.0.mca")).toBe(true);
    expect(m("world/level.dat")).toBe(false);
  });

  it("double star segments", () => {
    const m = compileExcludeMatcher(["a/**/b", "**/x.log", "top/**"]);
    expect(m("a/b")).toBe(true);
    expect(m("a/1/2/3/b")).toBe(true);
    expect(m("a/1/2/c")).toBe(false);
    expect(m("x.log")).toBe(true);
    expect(m("1/2/x.log")).toBe(true);
    expect(m("1/2/y.log")).toBe(false);
    expect(m("top/a/b")).toBe(true);
    expect(m("other/top/a")).toBe(false);
    expect(compileExcludeMatcher(["**"])("anything/at/all")).toBe(true);
  });

  it("rejects invalid patterns", () => {
    expect(() => compileExcludeMatcher(["../x"])).toThrow();
    expect(() => compileExcludeMatcher(["[a]"])).toThrow();
  });

  it("pathological patterns finish fast", () => {
    const pattern = "*a".repeat(60) + "*b"; // 122 chars
    const text = "a".repeat(255);
    const start = Date.now();
    expect(matchGlobSegment(pattern, text)).toBe(false);
    const m = compileExcludeMatcher([
      pattern,
      "**/" + pattern,
      "**/**/**/**/**/**/**/" + "*?".repeat(50) + "x"
    ]);
    const deep = Array(200).fill(text).join("/");
    expect(m(deep)).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("name, retention, schedule", () => {
  it("names", () => {
    expect(validateBackupName("ok").ok).toBe(true);
    expect(validateBackupName("a".repeat(40)).ok).toBe(true);
    for (const bad of ["", "   ", "a".repeat(41), 5, undefined, "a\u0000b"]) {
      expect(code(validateBackupName(bad))).toBe(C.NAME_INVALID);
    }
  });

  it("retention", () => {
    for (const ok of [1, 50, 100]) expect(validateRetention(ok).ok).toBe(true);
    for (const bad of [0, 101, -1, 1.5, "3", NaN, undefined]) {
      expect(code(validateRetention(bad))).toBe(C.RETENTION_INVALID);
    }
  });

  it("cron", () => {
    for (const ok of [
      "0 3 * * *",
      "*/15 * * * *",
      "0 0 1 1 0",
      "0,30 8-18 * * 1-5",
      "5 0 3 * * *",
      "0 0 * * 7"
    ]) {
      expect(isValidBackupCron(ok)).toBe(true);
    }
    for (const bad of [
      "",
      "* * * *",
      "* * * * * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * * 13 *",
      "* * * * 8",
      "*/0 * * * *",
      "? * * * *",
      "*/5 * * * * *",
      "0 */5 * * * *x",
      "a * * * *",
      "5-1 * * * *",
      "0 0 * * mon",
      "1\n2 * * * *"
    ]) {
      expect(isValidBackupCron(bad)).toBe(false);
    }
  });

  it("schedule", () => {
    expect(validateSchedule(undefined).ok).toBe(true);
    expect(validateSchedule(null).ok).toBe(true);
    expect(validateSchedule({ kind: "interval", value: "3600" }).ok).toBe(true);
    expect(validateSchedule({ kind: "interval", value: "60" }).ok).toBe(true);
    expect(validateSchedule({ kind: "cron", value: "0 3 * * *" }).ok).toBe(true);
    expect(code(validateSchedule({ kind: "interval", value: "59" }))).toBe(
      C.SCHEDULE_INTERVAL_INVALID
    );
    expect(code(validateSchedule({ kind: "interval", value: "31536001" }))).toBe(
      C.SCHEDULE_INTERVAL_INVALID
    );
    expect(code(validateSchedule({ kind: "interval", value: "1e3" }))).toBe(
      C.SCHEDULE_INTERVAL_INVALID
    );
    expect(code(validateSchedule({ kind: "interval", value: "-5" }))).toBe(
      C.SCHEDULE_INTERVAL_INVALID
    );
    expect(code(validateSchedule({ kind: "cron", value: "nope" }))).toBe(C.SCHEDULE_CRON_INVALID);
    expect(code(validateSchedule({ kind: "weekly", value: "1" }))).toBe(C.SCHEDULE_KIND_INVALID);
    expect(code(validateSchedule("x"))).toBe(C.SCHEDULE_INVALID);
    expect(code(validateSchedule({ kind: "cron", value: 5 }))).toBe(C.SCHEDULE_INVALID);
  });
});

function goodPlan(): any {
  return {
    id: "plan1",
    daemonId: "d",
    instanceUuid: "inst",
    name: "Nightly",
    preset: "minecraft-worlds",
    include: ["world"],
    exclude: ["*.tmp"],
    schedule: { kind: "cron", value: "0 3 * * *" },
    retention: 7,
    destinationIds: ["local", "s3a"],
    minecraftSaveHook: true,
    enabled: true
  };
}

describe("validatePlan", () => {
  it("accepts a good plan, with or without optional parts", () => {
    expect(validatePlan(goodPlan(), { requireIdentity: true }).ok).toBe(true);
    const p = goodPlan();
    delete p.schedule;
    delete p.id;
    delete p.daemonId;
    delete p.instanceUuid;
    expect(validatePlan(p).ok).toBe(true);
    expect(code(validatePlan(p, { requireIdentity: true }))).toBe(C.INVALID_ID);
  });

  const mutations: [string, (p: any) => void, string][] = [
    ["not object", () => {}, C.NOT_AN_OBJECT],
    ["bad id", (p) => (p.id = "a/b"), C.INVALID_ID],
    ["bad daemon", (p) => (p.daemonId = ""), C.INVALID_ID],
    ["bad name", (p) => (p.name = ""), C.NAME_INVALID],
    ["bad preset", (p) => (p.preset = "all"), C.PLAN_PRESET_INVALID],
    ["bad include", (p) => (p.include = ["../x"]), C.INCLUDE_TRAVERSAL],
    ["empty include", (p) => (p.include = []), C.INCLUDE_EMPTY_LIST],
    ["bad exclude", (p) => (p.exclude = ["[a]"]), C.EXCLUDE_UNSUPPORTED_SYNTAX],
    ["bad schedule", (p) => (p.schedule = { kind: "cron", value: "x" }), C.SCHEDULE_CRON_INVALID],
    ["bad retention", (p) => (p.retention = 0), C.RETENTION_INVALID],
    ["no destinations", (p) => (p.destinationIds = []), C.PLAN_DESTINATIONS_COUNT],
    [
      "too many destinations",
      (p) => (p.destinationIds = ["a", "b", "c", "d", "e", "f"]),
      C.PLAN_DESTINATIONS_COUNT
    ],
    ["dup destinations", (p) => (p.destinationIds = ["a", "a"]), C.PLAN_DESTINATIONS_DUPLICATE],
    ["bad destination id", (p) => (p.destinationIds = ["a b"]), C.INVALID_ID],
    ["destinations not array", (p) => (p.destinationIds = "a"), C.PLAN_DESTINATIONS_INVALID],
    ["hook flag", (p) => (p.minecraftSaveHook = "yes"), C.PLAN_FLAG_INVALID],
    ["enabled flag", (p) => delete p.enabled, C.PLAN_FLAG_INVALID]
  ];
  it.each(mutations)("rejects: %s", (name, mutate, expected) => {
    if (name === "not object") {
      expect(code(validatePlan(null))).toBe(expected);
      expect(code(validatePlan([]))).toBe(expected);
      return;
    }
    const p = goodPlan();
    mutate(p);
    expect(code(validatePlan(p))).toBe(expected);
  });

  it("treats a missing exclude as empty", () => {
    const p = goodPlan();
    delete p.exclude;
    expect(validatePlan(p).ok).toBe(true);
  });

  it("validateDestinationIds", () => {
    expect(validateDestinationIds(["a"]).ok).toBe(true);
    expect(validateDestinationIds(["a", "b", "c", "d", "e"]).ok).toBe(true);
  });
});

describe("S3 pieces", () => {
  it("endpoint accepts public https", () => {
    for (const ok of [
      "https://s3.amazonaws.com",
      "https://s3.us-east-1.amazonaws.com/",
      "https://acc.r2.cloudflarestorage.com",
      "https://minio.example.com:9000"
    ]) {
      expect(validateS3Endpoint(ok, false).ok).toBe(true);
    }
  });

  it.each([
    ["http://s3.example.com", C.S3_ENDPOINT_SCHEME],
    ["ftp://s3.example.com", C.S3_ENDPOINT_SCHEME],
    ["https://user:pass@s3.example.com", C.S3_ENDPOINT_CREDENTIALS],
    ["https://user@s3.example.com", C.S3_ENDPOINT_CREDENTIALS],
    ["https://s3.example.com/?a=b", C.S3_ENDPOINT_EXTRAS],
    ["https://s3.example.com/#x", C.S3_ENDPOINT_EXTRAS],
    ["https://s3.example.com/path", C.S3_ENDPOINT_EXTRAS],
    ["not a url", C.S3_ENDPOINT_INVALID],
    ["", C.S3_ENDPOINT_INVALID],
    ["https://" + "a".repeat(260) + ".com", C.S3_ENDPOINT_INVALID],
    ["https://localhost", C.S3_ENDPOINT_HOST_NOT_ALLOWED],
    ["https://10.0.0.5", C.S3_ENDPOINT_HOST_NOT_ALLOWED],
    ["https://[::1]", C.S3_ENDPOINT_HOST_NOT_ALLOWED],
    ["https://minio", C.S3_ENDPOINT_HOST_NOT_ALLOWED],
    ["https://nas.local", C.S3_ENDPOINT_HOST_NOT_ALLOWED],
    ["https://169.254.169.254", C.S3_ENDPOINT_HOST_NOT_ALLOWED]
  ])("endpoint rejects %s", (url, expected) => {
    expect(code(validateS3Endpoint(url, false))).toBe(expected);
  });

  it("private network opt-in allows http and IP literals but never metadata/unspecified", () => {
    expect(validateS3Endpoint("http://192.168.1.10:9000", true).ok).toBe(true);
    expect(validateS3Endpoint("https://localhost:9000", true).ok).toBe(true);
    expect(validateS3Endpoint("http://minio:9000", true).ok).toBe(true);
    expect(code(validateS3Endpoint("http://169.254.169.254", true))).toBe(
      C.S3_ENDPOINT_HOST_NOT_ALLOWED
    );
    expect(code(validateS3Endpoint("http://0.0.0.0", true))).toBe(C.S3_ENDPOINT_HOST_NOT_ALLOWED);
    expect(code(validateS3Endpoint("http://[fd00:ec2::254]", true))).toBe(
      C.S3_ENDPOINT_HOST_NOT_ALLOWED
    );
    expect(code(validateS3Endpoint("http://u:p@10.0.0.1", true))).toBe(C.S3_ENDPOINT_CREDENTIALS);
  });

  it("bucket naming", () => {
    for (const ok of ["abc", "my-bucket", "a.b.c", "bucket123", "a".repeat(63)]) {
      expect(validateS3Bucket(ok).ok).toBe(true);
    }
    for (const bad of [
      "ab",
      "a".repeat(64),
      "UPPER",
      "-abc",
      "abc-",
      ".abc",
      "a..b",
      "a.-b",
      "a-.b",
      "192.168.0.1",
      "a_b",
      "a b",
      "",
      5,
      undefined
    ]) {
      expect(code(validateS3Bucket(bad))).toBe(C.S3_BUCKET_INVALID);
    }
  });

  it("prefix", () => {
    for (const ok of [undefined, "", "backups", "backups/mc/", "a.b-c_d/e"]) {
      expect(validateS3Prefix(ok).ok).toBe(true);
    }
    for (const bad of [
      "/abs",
      "a//b",
      "../x",
      "a/../b",
      "./a",
      "a b",
      "a".repeat(129),
      5,
      "a\u0000"
    ]) {
      expect(code(validateS3Prefix(bad))).toBe(C.S3_PREFIX_INVALID);
    }
  });
});

function s3(): any {
  return {
    type: "s3",
    name: "S3",
    config: {
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "my-bucket",
      prefix: "mc/",
      pathStyle: false,
      allowPrivateNetwork: false,
      accessKeyId: "AKIA1234567890"
    },
    secrets: { secretAccessKey: "abcdefghijklmnop" }
  };
}

function oauth(): any {
  return {
    type: "gdrive",
    name: "Drive",
    config: { authMethod: "oauth", clientId: "123-abc.apps.googleusercontent.com" },
    secrets: { clientSecret: "GOCSPX-xyz" }
  };
}

function sa(): any {
  return {
    type: "gdrive",
    name: "Drive SA",
    config: { authMethod: "service_account", folderId: "1AbCdEfGhIjKlMnOp" },
    secrets: {
      serviceAccountJson: JSON.stringify({
        client_email: "bot@proj.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n"
      })
    }
  };
}

function local(): any {
  return {
    type: "local",
    name: "Local",
    config: { directory: "/var/backups/mcsm", maxTotalBytes: 10 * 1024 ** 3 },
    secrets: {}
  };
}

describe("validateDestination", () => {
  it("accepts valid destinations of each type", () => {
    for (const d of [s3(), oauth(), sa(), local()]) expect(validateDestination(d).ok).toBe(true);
    const d = oauth();
    d.secrets.refreshToken = "1//token";
    d.config.folderId = "1AbCdEfGhIjKlMnOp";
    d.config.connectedEmail = "me@example.com";
    d.id = "dest-1";
    expect(validateDestination(d).ok).toBe(true);
    expect(
      validateDestination({
        ...local(),
        config: { directory: "C:\\Backups\\mcsm", maxTotalBytes: 5 }
      }).ok
    ).toBe(true);
  });

  it("common failures", () => {
    expect(code(validateDestination(null))).toBe(C.NOT_AN_OBJECT);
    expect(code(validateDestination({ ...local(), id: "a/b" }))).toBe(C.INVALID_ID);
    expect(code(validateDestination({ ...local(), type: "ftp" }))).toBe(C.DEST_TYPE_INVALID);
    expect(code(validateDestination({ ...local(), name: "" }))).toBe(C.NAME_INVALID);
    expect(code(validateDestination({ ...local(), config: null }))).toBe(C.DEST_CONFIG_INVALID);
    expect(code(validateDestination({ ...local(), secrets: "x" }))).toBe(C.DEST_SECRETS_INVALID);
  });

  describe("local", () => {
    it.each([
      "relative/dir",
      "",
      "/",
      "//server/share",
      "/a/../etc",
      "C:\\",
      "C:",
      "\\\\server\\share",
      "/a\u0000b",
      "/a\\b",
      "/" + "a".repeat(600),
      "C:\\a\\..\\b",
      "/a/<b>",
      "C:\\a:b",
      5 as any
    ])("rejects directory %j", (directory) => {
      const d = local();
      d.config.directory = directory;
      expect(code(validateDestination(d))).toBe(C.LOCAL_DIRECTORY_INVALID);
    });

    it.each([0, -1, 1.5, "10", NaN, Infinity, undefined, 2 ** 60])(
      "rejects maxTotalBytes %j",
      (v) => {
        const d = local();
        d.config.maxTotalBytes = v;
        expect(code(validateDestination(d))).toBe(C.LOCAL_MAX_SIZE_INVALID);
      }
    );
  });

  describe("s3", () => {
    it("flags, endpoint, region, bucket, prefix, key", () => {
      let d = s3();
      d.config.pathStyle = "yes";
      expect(code(validateDestination(d))).toBe(C.S3_FLAG_INVALID);
      d = s3();
      delete d.config.allowPrivateNetwork;
      expect(code(validateDestination(d))).toBe(C.S3_FLAG_INVALID);
      d = s3();
      d.config.endpoint = "http://s3.example.com";
      expect(code(validateDestination(d))).toBe(C.S3_ENDPOINT_SCHEME);
      d = s3();
      d.config.endpoint = "http://10.0.0.1:9000";
      d.config.allowPrivateNetwork = true;
      expect(validateDestination(d).ok).toBe(true);
      d = s3();
      d.config.region = "us east";
      expect(code(validateDestination(d))).toBe(C.S3_REGION_INVALID);
      d = s3();
      d.config.bucket = "A";
      expect(code(validateDestination(d))).toBe(C.S3_BUCKET_INVALID);
      d = s3();
      d.config.prefix = "../x";
      expect(code(validateDestination(d))).toBe(C.S3_PREFIX_INVALID);
      d = s3();
      d.config.accessKeyId = "a b";
      expect(code(validateDestination(d))).toBe(C.S3_ACCESS_KEY_INVALID);
    });

    it("secrets", () => {
      let d = s3();
      d.secrets = {};
      expect(code(validateDestination(d))).toBe(C.DEST_SECRET_MISSING);
      expect(validateDestination(d, { requireSecrets: false }).ok).toBe(true);
      d = s3();
      d.secrets.secretAccessKey = BACKUP_SECRET_MASK;
      expect(code(validateDestination(d))).toBe(C.DEST_SECRETS_INVALID);
      expect(validateDestination(d, { allowMaskedSecrets: true }).ok).toBe(true);
      d = s3();
      d.secrets.secretAccessKey = "x".repeat(300);
      expect(code(validateDestination(d))).toBe(C.DEST_SECRETS_INVALID);
      d = s3();
      d.secrets.secretAccessKey = 12345;
      expect(code(validateDestination(d))).toBe(C.DEST_SECRETS_INVALID);
      d = s3();
      d.secrets.secretAccessKey = "abc\u0000def";
      expect(code(validateDestination(d))).toBe(C.DEST_SECRETS_INVALID);
    });
  });

  describe("gdrive", () => {
    it("auth method and ids", () => {
      let d = oauth();
      d.config.authMethod = "basic";
      expect(code(validateDestination(d))).toBe(C.GDRIVE_AUTH_METHOD_INVALID);
      d = oauth();
      d.config.clientId = "";
      expect(code(validateDestination(d))).toBe(C.GDRIVE_CLIENT_ID_INVALID);
      d = oauth();
      d.config.clientId = "a b c d e";
      expect(code(validateDestination(d))).toBe(C.GDRIVE_CLIENT_ID_INVALID);
      d = oauth();
      d.config.folderId = "../x";
      expect(code(validateDestination(d))).toBe(C.GDRIVE_FOLDER_ID_INVALID);
      d = oauth();
      d.config.connectedEmail = "x".repeat(300);
      expect(code(validateDestination(d))).toBe(C.DEST_CONFIG_INVALID);
    });

    it("oauth secrets", () => {
      let d = oauth();
      d.secrets = {};
      expect(code(validateDestination(d))).toBe(C.DEST_SECRET_MISSING);
      d = oauth();
      d.secrets = { clientSecret: BACKUP_SECRET_MASK, refreshToken: BACKUP_SECRET_MASK };
      expect(validateDestination(d, { allowMaskedSecrets: true }).ok).toBe(true);
      expect(code(validateDestination(d))).toBe(C.DEST_SECRETS_INVALID);
    });

    it("service account", () => {
      let d = sa();
      delete d.config.folderId;
      expect(code(validateDestination(d))).toBe(C.GDRIVE_FOLDER_ID_INVALID);
      d = sa();
      d.secrets = {};
      expect(code(validateDestination(d))).toBe(C.DEST_SECRET_MISSING);
      expect(validateDestination(d, { requireSecrets: false }).ok).toBe(true);
      d = sa();
      d.secrets.serviceAccountJson = "not json";
      expect(code(validateDestination(d))).toBe(C.GDRIVE_SERVICE_ACCOUNT_INVALID);
      d = sa();
      d.secrets.serviceAccountJson = JSON.stringify({ client_email: "x" });
      expect(code(validateDestination(d))).toBe(C.GDRIVE_SERVICE_ACCOUNT_INVALID);
      d = sa();
      d.secrets.serviceAccountJson = "{".padEnd(
        BACKUP_LIMITS.MAX_SERVICE_ACCOUNT_JSON_LENGTH + 1,
        " "
      );
      expect(code(validateDestination(d))).toBe(C.GDRIVE_SERVICE_ACCOUNT_INVALID);
      d = sa();
      d.secrets.serviceAccountJson = BACKUP_SECRET_MASK;
      expect(code(validateDestination(d))).toBe(C.GDRIVE_SERVICE_ACCOUNT_INVALID);
      expect(validateDestination(d, { allowMaskedSecrets: true }).ok).toBe(true);
    });
  });
});
