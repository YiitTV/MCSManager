import { expect, it, vi } from "vitest";
import { CrashHistory, CrashOutputTail } from "../history";
import { CRASH_OUTPUT_LIMIT } from "../parser";

const { stored } = vi.hoisted(() => ({ stored: new Map<string, unknown>() }));
vi.mock("../../../common/system_storage", () => ({
  default: {
    load: (_category: string, _type: null, id: string) => stored.get(id),
    store: (_category: string, id: string, data: unknown) =>
      stored.set(id, JSON.parse(JSON.stringify(data))),
    delete: (_category: string, id: string) => stored.delete(id)
  }
}));

it("keeps the latest ten crash summaries per instance and reloads them from storage", async () => {
  const history = new CrashHistory("inst1");
  for (let at = 1; at <= 12; at++) {
    await history.record(undefined, "java.lang.IllegalStateException: Server stopped", at, 1);
  }
  const reloaded = new CrashHistory("inst1");
  expect(reloaded.latestAt).toBe(12);
  expect(reloaded.list().map((item) => item.at)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  expect(reloaded.list()[0]).toMatchObject({
    exception: "java.lang.IllegalStateException",
    exitCode: 1
  });
  expect(new CrashHistory("inst2").list()).toEqual([]);
  history.remove();
  expect(new CrashHistory("inst1").list()).toEqual([]);
});

it("keeps a bounded suffix in output order and resets between runs", () => {
  const output = new CrashOutputTail();
  const finalLines = "\njava.lang.IllegalStateException: Server stopped\n";
  output.append("x".repeat(CRASH_OUTPUT_LIMIT * 2));
  output.append(finalLines);
  expect(output.take()).toBe("x".repeat(CRASH_OUTPUT_LIMIT - finalLines.length) + finalLines);
  expect(output.take()).toBe("");
});
