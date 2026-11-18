import { describe, expect, it } from "vitest";
import {
  PatternLineMatcher,
  matchPattern,
  stripAnsi,
  validatePattern
} from "../instance_group_matcher";

describe("validatePattern", () => {
  it("accepts the default pattern", () => {
    expect(validatePattern("Done (*)!")).toBeNull();
  });
  it("rejects non-strings, empty and wildcard-only patterns", () => {
    expect(validatePattern(5)).toBe("type");
    expect(validatePattern("")).toBe("empty");
    expect(validatePattern("***")).toBe("empty");
  });
  it("rejects over-long patterns and more than 5 wildcards", () => {
    expect(validatePattern("a".repeat(201))).toBe("length");
    expect(validatePattern("a".repeat(200))).toBeNull();
    expect(validatePattern("a*b*c*d*e*f*g")).toBe("wildcards");
    expect(validatePattern("a*b*c*d*e*f")).toBeNull();
  });
});

describe("matchPattern", () => {
  it("matches the Minecraft ready line", () => {
    expect(
      matchPattern("Done (*)!", '[Server thread/INFO]: Done (3.2s)! For help, type "help"')
    ).toBe(true);
    expect(matchPattern("Done (*)!", "Done (1.2s)!")).toBe(true);
  });
  it("is case-sensitive and requires segment order", () => {
    expect(matchPattern("Done (*)!", "done (1s)!")).toBe(false);
    expect(matchPattern("Done (*)!", ")! then Done (")).toBe(false);
  });
  it("ignores ANSI colour codes", () => {
    expect(matchPattern("Done (*)!", "\u001b[32mDone (\u001b[1m1.5s\u001b[0m)!\u001b[0m")).toBe(
      true
    );
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
  });
  it("treats regex syntax as literal text", () => {
    expect(matchPattern("(.+)+$", "xx (.+)+$ yy")).toBe(true);
    expect(matchPattern("(.+)+$", "aaaaaaaa")).toBe(false);
  });
  it("finishes quickly on a pathological long line", () => {
    const line = "a".repeat(100_000) + "b";
    const start = Date.now();
    expect(matchPattern("a*a*a*a*a*c", line)).toBe(false);
    expect(matchPattern("a*a*a*a*a", line)).toBe(true);
    expect(Date.now() - start).toBeLessThan(500);
  });
  it("truncates lines to 4096 characters before matching", () => {
    expect(matchPattern("tail", "x".repeat(5000) + "tail")).toBe(false);
    expect(matchPattern("head", "head" + "x".repeat(5000))).toBe(true);
  });
  it("returns false for an invalid pattern", () => {
    expect(matchPattern("", "anything")).toBe(false);
  });
});

describe("PatternLineMatcher", () => {
  it("matches across chunk boundaries", () => {
    const m = new PatternLineMatcher("Done (*)!");
    expect(m.feed("[INFO] Loading\n[INFO] Do")).toBe(false);
    expect(m.feed("ne (0.")).toBe(false);
    expect(m.feed("4s)!\n")).toBe(true);
  });
  it("matches an unterminated line", () => {
    const m = new PatternLineMatcher("Done (*)!");
    expect(m.feed("Done (2s)!")).toBe(true);
  });
  it("does not match when text is only spread across different lines", () => {
    const m = new PatternLineMatcher("Done (*)!");
    expect(m.feed("Done (\n")).toBe(false);
    expect(m.feed("1s)!\n")).toBe(false);
  });
  it("caps the carry buffer and still terminates quickly on huge input", () => {
    const m = new PatternLineMatcher("a*a*a*a*a*z");
    const start = Date.now();
    for (let i = 0; i < 50; i++) expect(m.feed("a".repeat(20_000))).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
    expect((m as any).carry.length).toBeLessThanOrEqual(8 * 1024);
  });
  it("rejects invalid patterns", () => {
    expect(() => new PatternLineMatcher("***")).toThrow();
  });
});
