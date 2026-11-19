import crypto from "node:crypto";
import fs from "fs-extra";
import path from "path";
import { BACKUP_SECRET_MASK, EncryptedSecret, isMaskedSecret } from "mcsmanager-common";

// AES-256-GCM encryption of backup destination secrets at rest.
// The key lives in `data/Config/backup_secret.key` (mode 0600), is created on first use and is
// never returned by any API nor logged. This protects copies of the data directory; it does not
// protect against a compromised panel host.

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

let keyFilePath = path.normalize(path.join(process.cwd(), "data", "Config", "backup_secret.key"));
let cachedKey: Buffer | null = null;

/** Test hook: use another key file and drop the cached key. */
export function setBackupSecretKeyFileForTest(filePath: string | null) {
  keyFilePath =
    filePath ?? path.normalize(path.join(process.cwd(), "data", "Config", "backup_secret.key"));
  cachedKey = null;
}

function decodeKey(text: string): Buffer {
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== KEY_BYTES) throw new Error("Backup secret key file is corrupted");
  return key;
}

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  fs.mkdirsSync(path.dirname(keyFilePath));
  if (!fs.existsSync(keyFilePath)) {
    try {
      // "wx": never overwrite an existing key (it would make stored secrets unreadable)
      fs.writeFileSync(keyFilePath, crypto.randomBytes(KEY_BYTES).toString("base64"), {
        flag: "wx",
        mode: 0o600
      });
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
    }
  }
  try {
    fs.chmodSync(keyFilePath, 0o600);
  } catch {
    // best effort (not supported on some platforms)
  }
  cachedKey = decodeKey(fs.readFileSync(keyFilePath, { encoding: "utf-8" }));
  return cachedKey;
}

export function encryptSecret(plain: string): EncryptedSecret {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", loadKey(), iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

/** Throws a generic error (no secret material) when the data was tampered with. */
export function decryptSecret(secret: EncryptedSecret): string {
  try {
    const iv = Buffer.from(secret.iv, "base64");
    const tag = Buffer.from(secret.tag, "base64");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("bad format");
    const decipher = crypto.createDecipheriv("aes-256-gcm", loadKey(), iv, {
      authTagLength: TAG_BYTES
    });
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf-8");
  } catch {
    throw new Error("Unable to decrypt backup secret");
  }
}

export function isEncryptedSecret(value: unknown): value is EncryptedSecret {
  const v = value as EncryptedSecret;
  return (
    !!v &&
    typeof v === "object" &&
    typeof v.iv === "string" &&
    typeof v.tag === "string" &&
    typeof v.ciphertext === "string"
  );
}

/** Mask helper: any present secret becomes the placeholder, absent stays empty. */
export function maskSecret(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  return BACKUP_SECRET_MASK;
}

/**
 * Merge incoming plain secrets (from a request) with the stored encrypted ones:
 * - masked placeholder, or the key missing from the request: keep the stored secret
 * - empty string: clear the secret
 * - any other string: encrypt as the new value
 */
export function mergeSecrets(
  stored: Record<string, EncryptedSecret | undefined>,
  incoming: Record<string, unknown> | undefined,
  allowedKeys: readonly string[]
): Record<string, EncryptedSecret | undefined> {
  const result: Record<string, EncryptedSecret | undefined> = {};
  for (const key of allowedKeys) {
    const existing = stored?.[key];
    const value = incoming?.[key];
    if (value === undefined || value === null || isMaskedSecret(value)) {
      if (existing) result[key] = existing;
    } else if (typeof value === "string" && value !== "") {
      result[key] = encryptSecret(value);
    }
  }
  return result;
}

/** Decrypt every stored secret (for a daemon request). */
export function decryptSecrets(
  stored: Record<string, EncryptedSecret | undefined>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(stored ?? {})) {
    if (isEncryptedSecret(value)) result[key] = decryptSecret(value);
  }
  return result;
}
