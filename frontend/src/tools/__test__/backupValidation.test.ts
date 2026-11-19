import { describe, expect, it } from "vitest";
import {
  checkExcludeGlob,
  checkIncludeList,
  checkIncludePath,
  checkIntervalSeconds,
  checkLocalDirectory,
  checkRetention,
  checkS3Endpoint,
  isValidCron
} from "../backupValidation";

describe("include paths", () => {
  it.each([
    ["world", null],
    ["plugins/Essentials", null],
    [".", null],
    ["/etc", "absolute"],
    ["C:\\x", "absolute"],
    ["a/../b", "traversal"],
    ["..", "traversal"],
    ["%2e%2e/x", "traversal"],
    ["a*b", "illegalChar"],
    ["...", "illegalSegment"],
    ["", "empty"],
    ["x".repeat(257), "tooLong"]
  ])("%s -> %s", (value, code) => {
    expect(checkIncludePath(value)).toBe(code);
  });

  it("limits the list", () => {
    expect(checkIncludeList([])).toBe("includeEmptyList");
    expect(checkIncludeList(["a", "./a"])).toBe("duplicate");
    expect(checkIncludeList(Array.from({ length: 51 }, (_, i) => `p${i}`))).toBe("tooMany");
    expect(checkIncludeList(["a", "b"])).toBeNull();
  });
});

describe("exclude globs", () => {
  it.each([
    ["*.tmp", null],
    ["logs/**", null],
    ["a/**/b", null],
    ["!x", "unsupportedGlob"],
    ["[ab]", "unsupportedGlob"],
    ["a**b", "unsupportedGlob"],
    ["/abs", "absolute"],
    ["a\\b", "absolute"],
    ["a/../b", "traversal"],
    ["a//b", "emptySegment"]
  ])("%s -> %s", (value, code) => {
    expect(checkExcludeGlob(value)).toBe(code);
  });
});

describe("schedule / retention", () => {
  it("validates cron", () => {
    expect(isValidCron("0 4 * * *")).toBe(true);
    expect(isValidCron("*/5 * * * *")).toBe(true);
    expect(isValidCron("30 0 4 * * *")).toBe(true);
    expect(isValidCron("* * * *")).toBe(false);
    expect(isValidCron("*/5 0 4 * * *")).toBe(false);
    expect(isValidCron("61 * * * *")).toBe(false);
  });
  it("validates interval and retention", () => {
    expect(checkIntervalSeconds(59)).toBe("interval");
    expect(checkIntervalSeconds(60)).toBeNull();
    expect(checkIntervalSeconds(31536001)).toBe("interval");
    expect(checkRetention(0)).toBe("retention");
    expect(checkRetention(1)).toBeNull();
    expect(checkRetention(100)).toBeNull();
    expect(checkRetention(101)).toBe("retention");
    expect(checkRetention(1.5)).toBe("retention");
  });
});

describe("destination fields", () => {
  it("validates S3 endpoints", () => {
    expect(checkS3Endpoint("https://s3.example.com", false)).toBeNull();
    expect(checkS3Endpoint("http://s3.example.com", false)).toBe("endpointScheme");
    expect(checkS3Endpoint("https://10.0.0.5", false)).toBe("endpointHost");
    expect(checkS3Endpoint("http://10.0.0.5:9000", true)).toBeNull();
    expect(checkS3Endpoint("https://169.254.169.254", true)).toBe("endpointHost");
    expect(checkS3Endpoint("https://u:p@s3.example.com", false)).toBe("endpoint");
  });
  it("validates local directories", () => {
    expect(checkLocalDirectory("/var/backups")).toBeNull();
    expect(checkLocalDirectory("D:\\backups")).toBeNull();
    expect(checkLocalDirectory("backups")).toBe("directory");
    expect(checkLocalDirectory("/")).toBe("directory");
    expect(checkLocalDirectory("/a/../b")).toBe("directory");
  });
});
