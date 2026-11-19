import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstanceGroupView } from "@/types/instanceGroup";

vi.mock("@/lang/i18n", () => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key
}));

import { useInstanceGroupEditor, type EditorMember } from "../useInstanceGroupEditor";

const m = (id: string): EditorMember => ({ daemonId: "d", instanceUuid: id, nickname: id });

const existing: InstanceGroupView = {
  uuid: "g",
  run: null,
  name: "Net",
  members: [
    { daemonId: "d", instanceUuid: "lobby", available: true, nickname: "Lobby", status: 0 },
    { daemonId: "d", instanceUuid: "main", available: true, nickname: "Main", status: 0 },
    { daemonId: "d", instanceUuid: "proxy", available: true, nickname: "Proxy", status: 0 }
  ],
  stopOrder: ["d::proxy", "d::main", "d::lobby"],
  advance: {
    mode: "pattern",
    pattern: "Done (*)!",
    delaySec: 15,
    startTimeoutSec: 180,
    stopTimeoutSec: 180
  },
  createdAt: 0,
  updatedAt: 0
};

describe("useInstanceGroupEditor ordering", () => {
  let editor: ReturnType<typeof useInstanceGroupEditor>;
  beforeEach(() => {
    editor = useInstanceGroupEditor();
    editor.reset(existing);
  });

  it("loads start and stop order independently", () => {
    expect(editor.form.members.map((x) => x.instanceUuid)).toEqual(["lobby", "main", "proxy"]);
    expect(editor.stopMembers.value.map((x) => x.instanceUuid)).toEqual(["proxy", "main", "lobby"]);
  });

  it("moving in the stop order does not change the start order", () => {
    editor.moveStop("d::lobby", -1);
    expect(editor.stopMembers.value.map((x) => x.instanceUuid)).toEqual(["proxy", "lobby", "main"]);
    expect(editor.form.members.map((x) => x.instanceUuid)).toEqual(["lobby", "main", "proxy"]);
  });

  it("moving in the start order does not change the stop order", () => {
    editor.moveStart("d::proxy", -1);
    expect(editor.form.members.map((x) => x.instanceUuid)).toEqual(["lobby", "proxy", "main"]);
    expect(editor.form.stopOrder).toEqual(["d::proxy", "d::main", "d::lobby"]);
  });

  it("ignores moves past either end", () => {
    editor.moveStart("d::lobby", -1);
    editor.moveStop("d::lobby", 1);
    expect(editor.form.members[0].instanceUuid).toBe("lobby");
    expect(editor.form.stopOrder[2]).toBe("d::lobby");
  });

  it("appends added members to both orders and ignores duplicates", () => {
    expect(editor.addMembers([m("lobby"), m("extra")])).toBe(1);
    expect(editor.form.members.at(-1)?.instanceUuid).toBe("extra");
    expect(editor.form.stopOrder.at(-1)).toBe("d::extra");
  });

  it("removes a member from both orders", () => {
    editor.removeMember("d::main");
    expect(editor.form.members.map((x) => x.instanceUuid)).toEqual(["lobby", "proxy"]);
    expect(editor.form.stopOrder).toEqual(["d::proxy", "d::lobby"]);
  });

  it("syncMembers keeps order of kept members, drops removed, appends new", () => {
    editor.syncMembers([m("proxy"), m("lobby"), m("new")]);
    expect(editor.form.members.map((x) => x.instanceUuid)).toEqual(["lobby", "proxy", "new"]);
    expect(editor.form.stopOrder).toEqual(["d::proxy", "d::lobby", "d::new"]);
  });

  it("caps members at 30", () => {
    editor.reset();
    editor.addMembers(Array.from({ length: 35 }, (_, i) => m(`i${i}`)));
    expect(editor.form.members).toHaveLength(30);
    expect(editor.form.stopOrder).toHaveLength(30);
  });

  it("toInput sends a stop order that is a permutation of the members", () => {
    editor.moveStop("d::lobby", -1);
    const input = editor.toInput();
    expect([...input.stopOrder].sort()).toEqual(
      input.members.map((x) => `${x.daemonId}::${x.instanceUuid}`).sort()
    );
    expect(input.stopOrder).toEqual(["d::proxy", "d::lobby", "d::main"]);
  });
});

describe("useInstanceGroupEditor validation", () => {
  let editor: ReturnType<typeof useInstanceGroupEditor>;
  beforeEach(() => {
    editor = useInstanceGroupEditor();
    editor.reset(existing);
  });

  it("accepts a valid group", () => {
    expect(editor.isValid.value).toBe(true);
  });

  it("rejects an empty and a too long name", () => {
    editor.form.name = "   ";
    expect(editor.errors.value.join()).toContain("errNameRequired");
    editor.form.name = "x".repeat(41);
    expect(editor.errors.value.join()).toContain("errNameTooLong");
    editor.form.name = "x".repeat(40);
    expect(editor.isValid.value).toBe(true);
  });

  it("requires at least one member", () => {
    editor.form.members = [];
    editor.form.stopOrder = [];
    expect(editor.errors.value.join()).toContain("errMembersRequired");
  });

  it("validates the ready pattern", () => {
    editor.form.advance.pattern = "";
    expect(editor.errors.value.join()).toContain("errPatternRequired");
    editor.form.advance.pattern = "x".repeat(201);
    expect(editor.errors.value.join()).toContain("errPatternTooLong");
    editor.form.advance.pattern = "*a*b*c*d*e*f";
    expect(editor.errors.value.join()).toContain("errPatternWildcards");
    editor.form.advance.pattern = "*a*b*c*d*e";
    expect(editor.isValid.value).toBe(true);
  });

  it("validates timeouts and the delay", () => {
    editor.form.advance.startTimeoutSec = 4;
    expect(editor.errors.value.join()).toContain("errTimeoutRange");
    editor.form.advance.startTimeoutSec = 180;
    editor.form.advance.stopTimeoutSec = 3601;
    expect(editor.errors.value.join()).toContain("errTimeoutRange");
    editor.form.advance.stopTimeoutSec = 180;

    editor.form.advance.mode = "delay";
    editor.form.advance.delaySec = 3601;
    expect(editor.errors.value.join()).toContain("errDelayRange");
    editor.form.advance.delaySec = 200;
    expect(editor.errors.value.join()).toContain("errDelayExceedsTimeout");
    editor.form.advance.delaySec = 30;
    expect(editor.isValid.value).toBe(true);
  });

  it("does not require a pattern in other modes", () => {
    editor.form.advance.mode = "running";
    editor.form.advance.pattern = "";
    expect(editor.isValid.value).toBe(true);
  });
});
