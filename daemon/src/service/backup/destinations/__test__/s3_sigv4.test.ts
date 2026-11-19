import { describe, expect, it } from "vitest";
import {
  canonicalQueryString,
  encodeS3Path,
  formatAmzDate,
  sha256Hex,
  signRequest,
  uriEncode
} from "../s3_sigv4";

// AWS docs "Signature Calculations for the Authorization Header" S3 examples.
const AK = "AKIAIOSFODNN7EXAMPLE";
const SK = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const DATE = "20130524T000000Z";
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const base = { accessKeyId: AK, secretAccessKey: SK, region: "us-east-1", amzDate: DATE };
const host = "examplebucket.s3.amazonaws.com";

describe("sigv4 vectors", () => {
  it("GET object with Range", () => {
    const r = signRequest({
      ...base,
      method: "GET",
      canonicalUri: "/test.txt",
      headers: { host, range: "bytes=0-9", "x-amz-content-sha256": EMPTY, "x-amz-date": DATE },
      payloadHash: EMPTY
    });
    expect(r.signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(r.signedHeaders).toBe("host;range;x-amz-content-sha256;x-amz-date");
  });

  it("PUT object", () => {
    const payload = "Welcome to Amazon S3.";
    const hash = sha256Hex(payload);
    expect(hash).toBe("44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
    const r = signRequest({
      ...base,
      method: "PUT",
      canonicalUri: encodeS3Path("/test$file.text"),
      headers: {
        date: "Fri, 24 May 2013 00:00:00 GMT",
        host,
        "x-amz-content-sha256": hash,
        "x-amz-date": DATE,
        "x-amz-storage-class": "REDUCED_REDUNDANCY"
      },
      payloadHash: hash
    });
    expect(r.signature).toBe("98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });

  it("GET bucket lifecycle", () => {
    const r = signRequest({
      ...base,
      method: "GET",
      canonicalUri: "/",
      query: [["lifecycle", ""]],
      headers: { host, "x-amz-content-sha256": EMPTY, "x-amz-date": DATE },
      payloadHash: EMPTY
    });
    expect(r.signature).toBe("fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543");
  });

  it("GET bucket list objects (sorted query)", () => {
    const r = signRequest({
      ...base,
      method: "GET",
      canonicalUri: "/",
      query: { prefix: "J", "max-keys": "2" },
      headers: { host, "x-amz-content-sha256": EMPTY, "x-amz-date": DATE },
      payloadHash: EMPTY
    });
    expect(r.signature).toBe("34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });

  it("generic get-vanilla (non-s3 service)", () => {
    const r = signRequest({
      method: "GET",
      canonicalUri: "/",
      headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
      payloadHash: EMPTY,
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "service",
      amzDate: "20150830T123600Z"
    });
    expect(r.signature).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
    expect(r.authorization).toContain(
      "Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request"
    );
  });
});

describe("encoding helpers", () => {
  it("encodes segments once and keeps slashes", () => {
    expect(encodeS3Path("a b/c+d/é~.zip")).toBe("a%20b/c%2Bd/%C3%A9~.zip");
    expect(uriEncode("a/b")).toBe("a%2Fb");
    expect(uriEncode("a/b", false)).toBe("a/b");
  });
  it("sorts query and encodes values", () => {
    expect(
      canonicalQueryString([
        ["b", "x y"],
        ["a", "1"],
        ["a", ""]
      ])
    ).toBe("a=&a=1&b=x%20y");
  });
  it("formats amz date", () => {
    expect(formatAmzDate(new Date("2013-05-24T00:00:00.123Z"))).toBe(DATE);
  });
});
