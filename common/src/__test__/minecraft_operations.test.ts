import { describe, expect, it } from "vitest";
import {
  isMinecraftPlayerName,
  maintenanceConsoleCommand,
  parseMaintenanceOperation,
  parsePlayerOperation,
  playerConsoleCommand
} from "../minecraft_operations";

describe("Minecraft operation validation", () => {
  it("requires a literal player name for every action", () => {
    for (const name of ["ab", "a".repeat(17), "@a", "Notch\n", "two names", "Mınecraft"]) {
      expect(isMinecraftPlayerName(name)).toBe(false);
    }
    expect(isMinecraftPlayerName("Mine_123")).toBe(true);
    expect(parsePlayerOperation({ action: "constructor", player: "Notch" })).toBeUndefined();
    expect(parseMaintenanceOperation({ action: "add", player: "@a" })).toBeUndefined();
  });

  it("strips terminal controls and caps free text", () => {
    const operation = parsePlayerOperation({
      action: "kick",
      player: "Notch",
      text: "Önce\r\nkontrol\u0000\u001b " + "x".repeat(300)
    });
    expect(operation?.text).toHaveLength(160);
    expect(operation?.text).toMatch(/^Önce kontrol {2}x/u);
    expect(playerConsoleCommand("minecraft/java/paper", operation!)).toBe(
      `minecraft:kick Notch ${operation?.text}`
    );
  });

  it("rejects selectors, shell metacharacters and text on non-text actions", () => {
    for (const text of ["@a", "reason; extra command", "x|y", "x&y", "${text}", "   "]) {
      expect(parsePlayerOperation({ action: "tell", player: "Notch", text })).toBeUndefined();
    }
    expect(parsePlayerOperation({ action: "op", player: "Notch", text: "hello" })).toBeUndefined();
    expect(parsePlayerOperation({ action: "tell", player: "Notch" })).toBeUndefined();
    expect(
      playerConsoleCommand(
        "minecraft/java",
        parsePlayerOperation({ action: "pardon", player: "Notch" })!
      )
    ).toBe("pardon Notch");
  });

  it("maps maintenance mutations to fixed commands", () => {
    expect(parseMaintenanceOperation({ action: "toggle", enabled: "false" })).toBeUndefined();
    expect(maintenanceConsoleCommand({ action: "toggle", enabled: false })).toBe("maintenance off");
    expect(maintenanceConsoleCommand({ action: "add", player: "Notch" })).toBe(
      "maintenance add Notch"
    );
  });
});
