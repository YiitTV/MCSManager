// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { GroupRun, InstanceGroupView } from "@/types/instanceGroup";

vi.mock("@/lang/i18n", () => ({
  t: (key: string) => key,
  $t: (key: string) => key
}));
vi.mock("@/types/const", () => ({
  INSTANCE_STATUS_CODE: { BUSY: -1, STOPPED: 0, STOPPING: 1, STARTING: 2, RUNNING: 3 },
  INSTANCE_STATUS: {
    "-1": "busy",
    "0": "stopped",
    "1": "stopping",
    "2": "starting",
    "3": "running"
  }
}));

import InstanceGroupCard from "../InstanceGroupCard.vue";

const advance = {
  mode: "pattern" as const,
  pattern: "Done (*)!",
  delaySec: 15,
  startTimeoutSec: 180,
  stopTimeoutSec: 180
};

const group: InstanceGroupView = {
  uuid: "g1",
  run: null,
  name: "Minefield Network",
  members: [
    { daemonId: "d", instanceUuid: "lobby", available: true, nickname: "Lobby", status: 3 },
    { daemonId: "d", instanceUuid: "main", available: true, nickname: "Main", status: 0 },
    { daemonId: "d", instanceUuid: "gone", available: false }
  ],
  stopOrder: ["d::gone", "d::main", "d::lobby"],
  advance,
  createdAt: 0,
  updatedAt: 0
};

const run = (state: GroupRun["state"], action: GroupRun["action"] = "start"): GroupRun => ({
  runId: "r",
  groupId: "g1",
  action,
  state,
  startedAt: 0,
  steps: [
    { key: "d::lobby", state: "done" },
    { key: "d::main", state: "waiting" },
    { key: "d::gone", state: "pending" }
  ]
});

const mountCard = (props: Record<string, unknown> = {}) =>
  mount(InstanceGroupCard, { props: { group, run: null, ...props } });

describe("InstanceGroupCard", () => {
  it("renders the action buttons in the header, before the member rows", () => {
    const wrapper = mountCard();
    const html = wrapper.html();
    expect(wrapper.find('[data-test="btn-start"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="btn-stop"]').exists()).toBe(true);
    expect(html.indexOf("btn-start")).toBeLessThan(html.indexOf("member-row"));
    expect(wrapper.findAll('[data-test="member-row"]')).toHaveLength(3);
  });

  it("lists members in start order and mutes unavailable members without a name", () => {
    const wrapper = mountCard();
    const names = wrapper.findAll('[data-test="member-name"]').map((n) => n.text());
    expect(names).toEqual(["Lobby", "Main", "TXT_CODE_instance_group_ui.unavailable"]);
    const rows = wrapper.findAll('[data-test="member-row"]');
    expect(rows[2].classes()).toContain("member-unavailable");
    expect(rows[2].find('[data-test="btn-console"]').attributes("disabled")).toBeDefined();
    expect(rows[0].find('[data-test="btn-console"]').attributes("disabled")).toBeUndefined();
  });

  it("enables start and stop and hides cancel when idle", () => {
    const wrapper = mountCard();
    expect(wrapper.find('[data-test="btn-start"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.find('[data-test="btn-stop"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.find('[data-test="btn-cancel"]').exists()).toBe(false);
  });

  it("disables start, stop, edit and delete and shows cancel during a run", async () => {
    const wrapper = mountCard({ run: run("running") });
    for (const id of ["btn-start", "btn-stop", "btn-edit", "btn-delete"]) {
      expect(wrapper.find(`[data-test="${id}"]`).attributes("disabled")).toBeDefined();
    }
    const cancel = wrapper.find('[data-test="btn-cancel"]');
    expect(cancel.exists()).toBe(true);
    await cancel.trigger("click");
    expect(wrapper.emitted("cancel")).toHaveLength(1);
  });

  it("renders per-step progress", () => {
    const wrapper = mountCard({ run: run("running") });
    const steps = wrapper.findAll('[data-test="member-step"]').map((s) => s.text());
    expect(steps).toEqual([
      "TXT_CODE_instance_group_ui.stepDone",
      "TXT_CODE_instance_group_ui.stepWaiting",
      "TXT_CODE_instance_group_ui.stepPending"
    ]);
    expect(wrapper.find('[data-test="run-banner"]').text()).toContain("1 / 3");
  });

  it("follows the stop order while a stop run is active", () => {
    const wrapper = mountCard({ run: run("running", "stop") });
    const names = wrapper.findAll('[data-test="member-name"]').map((n) => n.text());
    expect(names).toEqual(["TXT_CODE_instance_group_ui.unavailable", "Main", "Lobby"]);
  });

  it("re-enables the buttons once the run finished and keeps the result visible", () => {
    const wrapper = mountCard({ run: run("failed") });
    expect(wrapper.find('[data-test="btn-start"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.find('[data-test="btn-cancel"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="run-banner"]').exists()).toBe(true);
  });

  it("emits start, stop and openConsole", async () => {
    const wrapper = mountCard();
    await wrapper.find('[data-test="btn-start"]').trigger("click");
    await wrapper.find('[data-test="btn-stop"]').trigger("click");
    await wrapper.findAll('[data-test="btn-console"]')[0].trigger("click");
    expect(wrapper.emitted("start")).toHaveLength(1);
    expect(wrapper.emitted("stop")).toHaveLength(1);
    expect(wrapper.emitted("openConsole")?.[0][0]).toMatchObject({ instanceUuid: "lobby" });
  });

  it("maps every machine step reason to a translation key and falls back for unknown codes", async () => {
    const { STEP_REASON_CODES, stepReasonLabel } = await import("../status");
    expect(STEP_REASON_CODES.sort()).toEqual(
      [
        "already_running",
        "already_stopped",
        "not_permitted",
        "stream_failed",
        "busy",
        "timeout",
        "failure",
        "stopped",
        "not_running",
        "stream_closed",
        "command_failed",
        "cancelled"
      ].sort()
    );
    for (const code of STEP_REASON_CODES)
      expect(stepReasonLabel(code)).toBe(`TXT_CODE_instance_group_ui.reason_${code}`);
    expect(stepReasonLabel("brand_new_code")).toBe("TXT_CODE_instance_group_ui.reason_unknown");
    expect(stepReasonLabel("__proto__")).toBe("TXT_CODE_instance_group_ui.reason_unknown");
    expect(stepReasonLabel(undefined)).toBe("");
  });

  it("shows the translated reason, never the raw code", () => {
    const failed = run("failed");
    failed.steps[1] = { key: "d::main", state: "failed", reason: "timeout" };
    const wrapper = mountCard({ run: failed });
    const reason = wrapper.find('[data-test="member-reason"]');
    expect(reason.text()).toBe("TXT_CODE_instance_group_ui.reason_timeout");
  });

  it("treats an available member without a status as unknown", () => {
    const g = {
      ...group,
      members: [{ daemonId: "d", instanceUuid: "lobby", available: true, nickname: "Lobby" }]
    };
    const wrapper = mountCard({ group: g, run: null });
    expect(wrapper.find('[data-test="member-status"]').text()).toBe(
      "TXT_CODE_instance_group_ui.unknown"
    );
  });
});
