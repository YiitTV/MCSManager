// @vitest-environment jsdom
import { useMiniConsoles } from "@/hooks/useMiniConsoles";
import type { InstanceDetail, LayoutCard } from "@/types";
import {
  DEFAULT_GROUP_ADVANCE,
  memberKey,
  type GroupMemberView,
  type GroupRun,
  type InstanceGroupView
} from "@/types/instanceGroup";
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InstanceGroupsBoard from "../InstanceGroupsBoard.vue";

const mocks = vi.hoisted(() => ({
  listGroups: vi.fn(),
  globalInstances: vi.fn(),
  nodeInstances: vi.fn(),
  userInfo: vi.fn(),
  instanceInfo: vi.fn(),
  isAdmin: true
}));

vi.mock("@/lang/i18n", () => ({
  t: (key: string) => key,
  $t: (key: string) => key
}));

vi.mock("@/stores/useAppStateStore", async () => {
  const { ref } = await import("vue");
  return { useAppStateStore: () => ({ isAdmin: ref(mocks.isAdmin) }) };
});

vi.mock("@/services/apis", () => ({
  remoteInstancesGlobal: () => ({ execute: mocks.globalInstances }),
  remoteInstances: () => ({ execute: mocks.nodeInstances }),
  userInfoApi: () => ({ execute: mocks.userInfo })
}));

vi.mock("@/services/apis/instance", () => ({
  getInstanceInfo: () => ({ execute: mocks.instanceInfo })
}));

vi.mock("@/services/apis/instanceGroup", () => ({
  listInstanceGroups: () => ({ execute: mocks.listGroups }),
  cancelInstanceGroupRun: vi.fn(),
  createInstanceGroup: vi.fn(),
  deleteInstanceGroup: vi.fn(),
  getInstanceGroupRun: vi.fn(),
  startInstanceGroup: vi.fn(),
  stopInstanceGroup: vi.fn(),
  restartInstanceGroupWithWarnings: vi.fn(),
  updateInstanceGroup: vi.fn()
}));

vi.mock("@/widgets/instanceGroup/InstanceGroupEditor.vue", () => ({
  default: { template: "<div />" }
}));

vi.mock("@/widgets/instance/Shortcut.vue", () => ({
  default: {
    props: ["targetInstanceInfo", "targetDaemonId", "hideManagementActions"],
    template: `<article :data-restricted="hideManagementActions" data-test="shortcut">
        <span data-test="instance-name">{{ targetInstanceInfo.config.nickname }}</span>
        <slot name="extra-actions" />
      </article>`
  }
}));

const card: LayoutCard = {
  id: "instances",
  type: "InstanceList",
  title: "Instances",
  width: 12,
  height: "unset",
  meta: {}
};
const detail = (instanceUuid: string, nickname: string) =>
  ({ instanceUuid, config: { nickname } }) as InstanceDetail;
const lobby: GroupMemberView = { daemonId: "node", instanceUuid: "lobby", available: true };
const main: GroupMemberView = { daemonId: "node", instanceUuid: "main", available: true };
const gone: GroupMemberView = { daemonId: "node", instanceUuid: "gone", available: false };
const group = (uuid: string, name: string, members: GroupMemberView[]): InstanceGroupView => ({
  uuid,
  name,
  members,
  run: null,
  stopOrder: members.map(memberKey).reverse(),
  advance: DEFAULT_GROUP_ADVANCE,
  createdAt: 0,
  updatedAt: 0
});

const mountBoard = async () => {
  const wrapper = mount(InstanceGroupsBoard, { props: { card } });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  mocks.isAdmin = true;
  mocks.listGroups.mockResolvedValue({
    value: [group("first", "Zeta", [lobby, main, gone]), group("second", "Alpha", [main])]
  });
  mocks.globalInstances.mockResolvedValue({
    value: {
      node: { instances: [detail("main", "Main"), detail("gone", "Private")], page: 1, maxPage: 2 },
      other: { instances: [detail("main", "Standalone")], page: 1, maxPage: 1 }
    }
  });
  mocks.nodeInstances.mockResolvedValue({ value: { data: [detail("lobby", "Lobby")] } });
});

afterEach(() => {
  useMiniConsoles().closeAll();
  vi.clearAllMocks();
});

describe("InstanceGroupsBoard", () => {
  it("renders columns in group order and cards in start order, including shared instances", async () => {
    const wrapper = await mountBoard();
    const columns = wrapper.get('[data-test="board-columns"]').element.children;
    expect([...columns].map((column) => column.querySelector("h5")?.textContent)).toEqual([
      "Zeta",
      "Alpha",
      "TXT_CODE_instance_group_ui.ungrouped"
    ]);
    expect(
      [...columns].map((column) =>
        [...column.querySelectorAll('[data-test="instance-name"]')].map((el) => el.textContent)
      )
    ).toEqual([["Lobby", "Main"], ["Main"], ["Standalone"]]);
    expect(mocks.nodeInstances).toHaveBeenCalledWith(
      expect.objectContaining({ params: { daemonId: "node", page: 2, page_size: 50 } })
    );
    wrapper.unmount();
  });

  it("renders unavailable members muted and omits instance controls even with inventory data", async () => {
    const wrapper = await mountBoard();
    const row = wrapper.findAll('[data-test="member-row"]')[2];
    expect(row.get('[data-test="member-unavailable"]').classes()).toContain("member-unavailable");
    expect(row.text()).toBe("TXT_CODE_instance_group_ui.unavailable");
    expect(row.find('[data-test="shortcut"]').exists()).toBe(false);
    expect(row.find('[data-test="btn-console"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="ungrouped-column"]').text()).not.toContain("Private");
    wrapper.unmount();
  });

  it("disables Start and Stop and shows Cancel while a stop run is active", async () => {
    const running: GroupRun = {
      runId: "run",
      groupId: "first",
      action: "stop",
      state: "running",
      startedAt: 0,
      steps: [{ key: memberKey(main), state: "waiting" }]
    };
    mocks.listGroups.mockResolvedValue({
      value: [{ ...group("first", "Zeta", [lobby, main]), run: running }]
    });
    const wrapper = await mountBoard();
    const column = wrapper.get('[data-test="group-card"]');
    expect(column.get('[data-test="btn-start"]').attributes("disabled")).toBeDefined();
    expect(column.get('[data-test="btn-stop"]').attributes("disabled")).toBeDefined();
    expect(column.get('[data-test="btn-cancel"]').attributes("disabled")).toBeUndefined();
    expect(column.get('[data-test="run-banner"]').text()).toContain("0 / 1");
    expect(column.findAll('[data-test="instance-name"]').map((el) => el.text())).toEqual([
      "Lobby",
      "Main"
    ]);
    wrapper.unmount();
  });

  it("opens mini consoles from both grouped and ungrouped cards without navigating", async () => {
    const wrapper = await mountBoard();
    await wrapper.get('[data-test="group-card"] [data-test="btn-console"]').trigger("click");
    await wrapper.get('[data-test="ungrouped-column"] [data-test="btn-console"]').trigger("click");
    expect(
      useMiniConsoles().windows.value.map((window) => [window.daemonId, window.title])
    ).toEqual([
      ["node", "Lobby"],
      ["other", "Standalone"]
    ]);
    expect(wrapper.emitted("openInstance")).toBeUndefined();
    wrapper.unmount();
  });

  it("uses assigned instances and hides management actions for regular users", async () => {
    mocks.isAdmin = false;
    mocks.userInfo.mockResolvedValue({ value: { instances: [lobby, main] } });
    mocks.instanceInfo.mockImplementation(async ({ params }) => {
      if (params.uuid === "main") throw new Error("Instance access revoked");
      return { value: detail("lobby", "Lobby") };
    });
    const wrapper = await mountBoard();
    expect(mocks.globalInstances).not.toHaveBeenCalled();
    expect(mocks.instanceInfo).toHaveBeenCalledTimes(2);
    const available = wrapper.findAll('[data-test="shortcut"]');
    expect(available).toHaveLength(1);
    expect(available[0].attributes("data-restricted")).toBe("true");
    expect(available[0].text()).toContain("Lobby");
    wrapper.unmount();
  });
});
