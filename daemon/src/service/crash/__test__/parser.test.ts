import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCrash } from "../parser";

const fixture = (file: string) =>
  readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
const report = fixture("paper-crash.txt");
const output = fixture("paper-output.log.txt");

describe("Paper crash parser", () => {
  it("uses the report's root cause and matches a plugin by its main class package", () => {
    expect(
      parseCrash(report, output, [
        { jar: "RegionGuard-2.1.jar", main: "com.minefield.regions.RegionPlugin" },
        { jar: "LuckPerms-Bukkit-5.4.153.jar" }
      ])
    ).toEqual({
      exception: "java.lang.IllegalStateException",
      message: "Async region access on Server thread",
      frames: [
        "at com.minefield.regions.RegionListener.onChunkLoad(RegionListener.java:72)",
        "at com.minefield.regions.RegionHooks.lambda$register$1(RegionHooks.java:33)",
        "at io.papermc.paper.plugin.manager.PaperEventManager.callEvent(PaperEventManager.java:54)"
      ],
      plugin: "RegionGuard-2.1.jar"
    });
  });

  it("reads Paper console output and matches the JAR recorded in a frame", () => {
    const result = parseCrash("", output, [{ jar: "LuckPerms-Bukkit-5.4.153.jar" }]);
    expect(result).toMatchObject({
      exception: "java.lang.IllegalStateException",
      message: "Storage closed",
      plugin: "LuckPerms-Bukkit-5.4.153.jar"
    });
    expect(result.frames).toContain("at java.base/java.lang.Thread.run(Thread.java:1583)");
  });

  it("matches plugin names against package segments, with a bounded frame list", () => {
    const frame = "at com.sk89q.worldguard.WorldGuard.getInstance(WorldGuard.java:42)";
    const log = [
      "\x1b[31mjava.lang.RuntimeException: plugin failed\x1b[0m",
      ...Array(20).fill(frame)
    ].join("\n");
    const result = parseCrash("", log, [{ jar: "WorldGuard-7.0.13.jar" }]);
    expect(result.plugin).toBe("WorldGuard-7.0.13.jar");
    expect(result.frames).toHaveLength(8);
    expect(result.message).toBe("plugin failed");
  });

  it("ignores stale console lines and returns an empty trace when evidence is missing", () => {
    expect(parseCrash("", output + "ordinary output\n".repeat(300), [])).toEqual({
      frames: []
    });
  });

  it("accepts timestamp and thread prefixes on the same stack trace line", () => {
    const result = parseCrash(
      "",
      "[08:13:41] [Server thread/ERROR]: java.lang.OutOfMemoryError: Java heap space\n" +
        "[08:13:41] [Server thread/ERROR]: \tat net.minecraft.server.Main.main(Main.java:90)",
      []
    );
    expect(result.exception).toBe("java.lang.OutOfMemoryError");
    expect(result.frames).toHaveLength(1);
  });
});
