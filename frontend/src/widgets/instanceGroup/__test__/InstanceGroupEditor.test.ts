// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { InstanceGroupView } from "@/types/instanceGroup";

vi.mock("@/lang/i18n", () => ({
  t: (key: string) => key,
  $t: (key: string) => key
}));
vi.mock("@/components/fc", () => ({ useSelectInstances: vi.fn() }));
vi.mock("@/services/apis", () => ({ userInfoApi: vi.fn() }));
vi.mock("@/stores/useAppStateStore", () => ({
  useAppStateStore: () => ({ isAdmin: { value: true } })
}));
vi.mock("@/tools/validator", () => ({ reportErrorMsg: vi.fn() }));

import InstanceGroupEditor from "../InstanceGroupEditor.vue";

const group: InstanceGroupView = {
  uuid: "g1",
  run: null,
  name: "Minefield Network",
  members: [
    { daemonId: "d", instanceUuid: "lobby", available: true, nickname: "Lobby", status: 0 },
    { daemonId: "d", instanceUuid: "main", available: true, nickname: "Main", status: 0 },
    { daemonId: "d", instanceUuid: "proxy", available: true, nickname: "Velocity", status: 0 }
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

beforeAll(() => {
  window.matchMedia =
    window.matchMedia ||
    ((query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined
      }) as unknown as MediaQueryList);
});

afterEach(() => {
  document.body.innerHTML = "";
});

const mountEditor = async (props: Record<string, unknown> = {}) => {
  const wrapper = mount(InstanceGroupEditor, {
    props: { open: true, group, ...props },
    attachTo: document.body
  });
  await flushPromises();
  return wrapper;
};

const q = (selector: string) => document.body.querySelector<HTMLElement>(selector);
const names = (selector: string) =>
  Array.from(document.body.querySelectorAll(`${selector} .order-name`)).map((e) => e.textContent);

describe("InstanceGroupEditor", () => {
  it("shows start and stop order independently", async () => {
    await mountEditor();
    expect(names('[data-test="start-order"]')).toEqual(["Lobby", "Main", "Velocity"]);
    expect(names('[data-test="stop-order"]')).toEqual(["Velocity", "Main", "Lobby"]);
  });

  it("reorders the stop order with the arrow buttons and keeps the start order", async () => {
    const wrapper = await mountEditor();
    q('[data-test="stop-up-2"]')!.click(); // Lobby up
    await flushPromises();
    expect(names('[data-test="stop-order"]')).toEqual(["Velocity", "Lobby", "Main"]);
    expect(names('[data-test="start-order"]')).toEqual(["Lobby", "Main", "Velocity"]);

    const ok = document.body.querySelector<HTMLElement>(".ant-modal-footer .ant-btn-primary")!;
    ok.click();
    await flushPromises();
    const saved = wrapper.emitted("save")![0][0] as any;
    expect(saved.stopOrder).toEqual(["d::proxy", "d::lobby", "d::main"]);
    expect(saved.members.map((m: any) => m.instanceUuid)).toEqual(["lobby", "main", "proxy"]);
  });

  it("reorders the start order and disables the edge arrows", async () => {
    await mountEditor();
    expect(q('[data-test="start-up-0"]')!.hasAttribute("disabled")).toBe(true);
    expect(q('[data-test="start-down-2"]')!.hasAttribute("disabled")).toBe(true);
    q('[data-test="start-down-0"]')!.click();
    await flushPromises();
    expect(names('[data-test="start-order"]')).toEqual(["Main", "Lobby", "Velocity"]);
  });

  it("removes a member from both orders", async () => {
    await mountEditor();
    q('[data-test="remove-1"]')!.click();
    await flushPromises();
    expect(names('[data-test="start-order"]')).toEqual(["Lobby", "Velocity"]);
    expect(names('[data-test="stop-order"]')).toEqual(["Velocity", "Lobby"]);
  });

  it("does not save an invalid form and shows the validation errors", async () => {
    const wrapper = await mountEditor({ group: undefined });
    document.body.querySelector<HTMLElement>(".ant-modal-footer .ant-btn-primary")!.click();
    await flushPromises();
    expect(wrapper.emitted("save")).toBeUndefined();
    expect(q('[data-test="editor-errors"]')).not.toBeNull();
    expect(q('[data-test="editor-errors"]')!.textContent).toContain("errNameRequired");
  });

  it("rejects a name longer than 40 characters", async () => {
    const wrapper = await mountEditor();
    const input = q('[data-test="input-name"]') as HTMLInputElement;
    input.value = "x".repeat(41);
    input.dispatchEvent(new Event("input"));
    await flushPromises();
    document.body.querySelector<HTMLElement>(".ant-modal-footer .ant-btn-primary")!.click();
    await flushPromises();
    expect(wrapper.emitted("save")).toBeUndefined();
    expect(q('[data-test="editor-errors"]')!.textContent).toContain("errNameTooLong");
  });

  it("lets the user remove an unavailable member and save", async () => {
    const withGone: InstanceGroupView = {
      ...group,
      members: [...group.members, { daemonId: "d", instanceUuid: "gone", available: false }],
      stopOrder: [...group.stopOrder, "d::gone"]
    };
    const wrapper = await mountEditor({ group: withGone });
    const items = Array.from(document.body.querySelectorAll('[data-test="start-item"]'));
    expect(items[3].classList.contains("order-unavailable")).toBe(true);
    expect(items[3].textContent).toContain("TXT_CODE_instance_group_ui.unavailable");
    q('[data-test="remove-3"]')!.click();
    await flushPromises();
    document.body.querySelector<HTMLElement>(".ant-modal-footer .ant-btn-primary")!.click();
    await flushPromises();
    const saved = wrapper.emitted("save")![0][0] as any;
    expect(saved.members.map((m: any) => m.instanceUuid)).toEqual(["lobby", "main", "proxy"]);
    expect(saved.stopOrder).not.toContain("d::gone");
  });

  it("shows the server error message inside the dialog", async () => {
    await mountEditor({ saveError: "Instance is no longer assigned to you" });
    expect(q('[data-test="save-error"]')!.textContent).toContain(
      "Instance is no longer assigned to you"
    );
  });
});
