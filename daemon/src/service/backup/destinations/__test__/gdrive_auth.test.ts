import crypto from "crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BackupDriverError, BackupDriverErrorCode } from "mcsmanager-common";
import {
  __setGoogleEndpointsForTests,
  createGoogleTokenProvider,
  getGoogleEndpoints,
  getProductionGoogleEndpoints,
  GOOGLE_SCOPE_DRIVE
} from "../gdrive_auth";
import { FakeGoogle } from "./gdrive_fake_server";

const fake = new FakeGoogle();
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});

beforeAll(async () => {
  await fake.start();
});
afterAll(async () => {
  __setGoogleEndpointsForTests(null);
  await fake.stop();
});
beforeEach(() => {
  __setGoogleEndpointsForTests(fake.endpoints());
  fake.tokenCalls = 0;
  fake.tokenForms = [];
  fake.tokenMode = "ok";
  fake.expiresIn = 3600;
  fake.tokenDelayMs = 0;
});
afterEach(() => {
  __setGoogleEndpointsForTests(fake.endpoints());
});

const oauth = () =>
  createGoogleTokenProvider(
    { authMethod: "oauth", clientId: "cid" },
    { clientSecret: "SECRET-CLIENT-xyz", refreshToken: "REFRESH-TOKEN-xyz" }
  );

describe("gdrive_auth OAuth", () => {
  it("exchanges the refresh token and caches the access token", async () => {
    const p = oauth();
    const a = await p.getToken();
    const b = await p.getToken();
    expect(a).toBe(b);
    expect(fake.tokenCalls).toBe(1);
    const form = fake.tokenForms[0];
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_id")).toBe("cid");
    expect(form.get("refresh_token")).toBe("REFRESH-TOKEN-xyz");
  });

  it("refreshes once the token is within 60 s of expiry", async () => {
    fake.expiresIn = 30;
    const p = oauth();
    await p.getToken();
    await p.getToken();
    expect(fake.tokenCalls).toBe(2);
  });

  it("invalidate() forces a new token", async () => {
    const p = oauth();
    await p.getToken();
    p.invalidate();
    await p.getToken();
    expect(fake.tokenCalls).toBe(2);
  });

  it("shares one request between concurrent callers", async () => {
    fake.tokenDelayMs = 50;
    const p = oauth();
    const tokens = await Promise.all([p.getToken(), p.getToken(), p.getToken()]);
    expect(new Set(tokens).size).toBe(1);
    expect(fake.tokenCalls).toBe(1);
  });

  it("maps invalid_grant to AUTH with a reconnect hint and no secrets", async () => {
    fake.tokenMode = "invalid_grant";
    const err = await oauth()
      .getToken()
      .catch((e) => e);
    expect(err).toBeInstanceOf(BackupDriverError);
    expect(err.code).toBe(BackupDriverErrorCode.AUTH);
    expect(err.message).toMatch(/reconnect/i);
    expect(err.message).not.toContain("REFRESH-TOKEN-xyz");
    expect(err.message).not.toContain("SECRET-CLIENT-xyz");
  });

  it("maps invalid_client to AUTH and 5xx to TRANSIENT", async () => {
    fake.tokenMode = "invalid_client";
    expect(
      (
        await oauth()
          .getToken()
          .catch((e) => e)
      ).code
    ).toBe(BackupDriverErrorCode.AUTH);
    fake.tokenMode = "500";
    const e = await oauth()
      .getToken()
      .catch((x) => x);
    expect(e.code).toBe(BackupDriverErrorCode.TRANSIENT);
    expect(e.retryable).toBe(true);
  });

  it("fails with AUTH when not connected", async () => {
    const p = createGoogleTokenProvider({ authMethod: "oauth", clientId: "c" }, {});
    expect((await p.getToken().catch((e) => e)).code).toBe(BackupDriverErrorCode.AUTH);
  });
});

describe("gdrive_auth service account", () => {
  const saJson = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "service_account",
      client_email: "sa@proj.iam.gserviceaccount.com",
      private_key: privateKey,
      token_uri: fake.endpoints().tokenUrl,
      ...extra
    });

  it("sends a correctly signed RS256 JWT assertion", async () => {
    const p = createGoogleTokenProvider(
      { authMethod: "service_account" },
      { serviceAccountJson: saJson() }
    );
    const before = Math.floor(Date.now() / 1000);
    await p.getToken();
    const form = fake.tokenForms[0];
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, s] = form.get("assertion")!.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT"
    });
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    expect(claims.iss).toBe("sa@proj.iam.gserviceaccount.com");
    expect(claims.scope).toBe(GOOGLE_SCOPE_DRIVE);
    expect(claims.aud).toBe(fake.endpoints().tokenUrl);
    expect(claims.iat).toBeGreaterThanOrEqual(before);
    expect(claims.exp - claims.iat).toBe(3600);
    const verify = crypto.createVerify("RSA-SHA256").update(`${h}.${c}`);
    expect(verify.verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("rejects a tampered token_uri without sending anything", async () => {
    const p = createGoogleTokenProvider(
      { authMethod: "service_account" },
      { serviceAccountJson: saJson({ token_uri: "https://evil.example.com/token" }) }
    );
    const err = await p.getToken().catch((e) => e);
    expect(err.code).toBe(BackupDriverErrorCode.AUTH);
    expect(err.message).not.toContain("evil.example.com");
    expect(fake.tokenCalls).toBe(0);
  });

  it("rejects malformed JSON and bad keys without leaking the key", async () => {
    for (const json of [
      "not json",
      JSON.stringify({ client_email: "a@b.c" }),
      saJson({ private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----" })
    ]) {
      const p = createGoogleTokenProvider(
        { authMethod: "service_account" },
        { serviceAccountJson: json }
      );
      const err = await p.getToken().catch((e) => e);
      expect(err.code).toBe(BackupDriverErrorCode.AUTH);
      expect(err.message).not.toContain("AAAA");
    }
    expect(fake.tokenCalls).toBe(0);
  });
});

describe("endpoint lockdown", () => {
  it("production endpoints are the hardcoded Google hosts", () => {
    __setGoogleEndpointsForTests(null);
    expect(getGoogleEndpoints()).toEqual({
      tokenUrl: "https://oauth2.googleapis.com/token",
      apiBase: "https://www.googleapis.com/drive/v3",
      uploadBase: "https://www.googleapis.com/upload/drive/v3"
    });
    expect(getProductionGoogleEndpoints()).toEqual(getGoogleEndpoints());
  });

  it("the override seam refuses to work outside a test run", () => {
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => __setGoogleEndpointsForTests(fake.endpoints())).toThrow();
    } finally {
      process.env.VITEST = saved;
    }
    __setGoogleEndpointsForTests(null);
    expect(getGoogleEndpoints().tokenUrl).toBe("https://oauth2.googleapis.com/token");
  });

  it("destination config cannot redirect traffic (extra fields are ignored)", async () => {
    __setGoogleEndpointsForTests(null);
    const p = createGoogleTokenProvider(
      { authMethod: "service_account", tokenUrl: "http://127.0.0.1:1/x" } as any,
      {
        serviceAccountJson: JSON.stringify({
          client_email: "a@b.c",
          private_key: privateKey,
          token_uri: "http://127.0.0.1:1/x"
        })
      }
    );
    expect((await p.getToken().catch((e) => e)).message).toMatch(/token endpoint/);
  });
});
