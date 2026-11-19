import { describe, expect, it } from "vitest";
import { hasVersionUpdate } from "../version";

describe("hasVersionUpdate", () => {
  it("ignores a fourth numeric segment in fork versions", () => {
    expect(hasVersionUpdate("4.19.3.1", "4.19.3")).toBe(false);
    expect(hasVersionUpdate("10.22.1.1", "10.22.1")).toBe(false);
  });
});
