import fs from "fs-extra";
import os from "node:os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKUP_SECRET_MASK } from "mcsmanager-common";
import {
  decryptSecret,
  decryptSecrets,
  encryptSecret,
  maskSecret,
  mergeSecrets,
  setBackupSecretKeyFileForTest
} from "../backup_secret";

let dir = "";
let keyFile = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bk-secret-"));
  keyFile = path.join(dir, "Config", "backup_secret.key");
  setBackupSecretKeyFileForTest(keyFile);
});
afterEach(() => {
  setBackupSecretKeyFileForTest(null);
  fs.removeSync(dir);
});

describe("backup_secret", () => {
  it("round trips and uses a random IV", () => {
    const a = encryptSecret("s3cr3t-value");
    const b = encryptSecret("s3cr3t-value");
    expect(decryptSecret(a)).toBe("s3cr3t-value");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(Buffer.from(a.iv, "base64")).toHaveLength(12);
    expect(JSON.stringify(a)).not.toContain("s3cr3t-value");
  });

  it("detects tampering of ciphertext, tag and iv without leaking", () => {
    const e = encryptSecret("hello");
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, "base64");
      buf[0] ^= 1;
      return buf.toString("base64");
    };
    for (const field of ["ciphertext", "tag", "iv"] as const) {
      expect(() => decryptSecret({ ...e, [field]: flip(e[field]) })).toThrow(
        "Unable to decrypt backup secret"
      );
    }
    expect(() => decryptSecret({ iv: "", tag: "", ciphertext: "" })).toThrow();
  });

  it.skipIf(process.platform === "win32")("creates the key file with mode 0600", () => {
    encryptSecret("x");
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(Buffer.from(fs.readFileSync(keyFile, "utf-8"), "base64")).toHaveLength(32);
  });

  it("reuses the key across restarts and refuses a corrupted key", () => {
    const e = encryptSecret("persist");
    setBackupSecretKeyFileForTest(keyFile); // drops the cache
    expect(decryptSecret(e)).toBe("persist");
    fs.writeFileSync(keyFile, "short");
    setBackupSecretKeyFileForTest(keyFile);
    expect(() => encryptSecret("x")).toThrow("corrupted");
    // the corrupted key is not silently replaced
    expect(fs.readFileSync(keyFile, "utf-8")).toBe("short");
  });

  it("masks and merges secrets", () => {
    expect(maskSecret("abc")).toBe(BACKUP_SECRET_MASK);
    expect(maskSecret("")).toBe("");
    expect(maskSecret(undefined)).toBe("");
    const stored = { secretAccessKey: encryptSecret("old") };
    const keep = mergeSecrets(stored, { secretAccessKey: BACKUP_SECRET_MASK }, ["secretAccessKey"]);
    expect(decryptSecrets(keep).secretAccessKey).toBe("old");
    const keep2 = mergeSecrets(stored, {}, ["secretAccessKey"]);
    expect(decryptSecrets(keep2).secretAccessKey).toBe("old");
    const changed = mergeSecrets(stored, { secretAccessKey: "new" }, ["secretAccessKey"]);
    expect(decryptSecrets(changed).secretAccessKey).toBe("new");
    const cleared = mergeSecrets(stored, { secretAccessKey: "" }, ["secretAccessKey"]);
    expect(cleared.secretAccessKey).toBeUndefined();
    // unknown keys are dropped
    const dropped = mergeSecrets({}, { evil: "x" }, ["secretAccessKey"]);
    expect(Object.keys(dropped)).toEqual([]);
  });
});
