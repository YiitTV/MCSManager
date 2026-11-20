import { describe, expect, it } from "vitest";
import { isMonitoringId } from "../instance_monitoring";

describe("monitoring identifier validation", () => {
  it("accepts UUIDs and bounded legacy identifiers", () => {
    expect(isMonitoringId("45cd7a52-9d95-4063-adf8-06ec51e3a620")).toBe(true);
    expect(isMonitoringId("Node_01")).toBe(true);
    expect(isMonitoringId("a".repeat(64))).toBe(true);
  });

  it.each([undefined, [], ["uuid"], 1, "", "a b", "a/b", "a\n", "a".repeat(65)])(
    "rejects invalid identifier %j",
    (value) => {
      expect(isMonitoringId(value)).toBe(false);
    }
  );
});
