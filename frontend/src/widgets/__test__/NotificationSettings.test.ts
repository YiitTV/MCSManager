// @vitest-environment jsdom
// Component tests for the Notifications settings tab with a mocked API module.
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { Modal } from "ant-design-vue";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import NotificationSettings from "@/widgets/NotificationSettings.vue";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  rotate: vi.fn(),
  test: vi.fn(),
  reportErrorMsg: vi.fn(),
  toCopy: vi.fn(),
  useSelectInstances: vi.fn()
}));

vi.mock("@/services/apis/notification", () => ({
  NOTIFICATION_SECRET_PLACEHOLDER: "__MCSM_SECRET_DATA__",
  getNotificationConfig: () => ({ execute: mocks.get }),
  putNotificationConfig: () => ({ execute: mocks.put }),
  rotateNotificationSecret: () => ({ execute: mocks.rotate }),
  testNotification: () => ({ execute: mocks.test })
}));

vi.mock("@/lang/i18n", () => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? key + " " + Object.values(params).join(",") : key
}));
vi.mock("@/tools/validator", () => ({ reportErrorMsg: mocks.reportErrorMsg }));
vi.mock("@/tools/copy", () => ({ toCopy: mocks.toCopy }));
vi.mock("@/components/fc", () => ({ useSelectInstances: mocks.useSelectInstances }));

const MASK = "__MCSM_SECRET_DATA__";

const serverConfig = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  sinkType: "bot_http",
  url: "https://bot.example.com/minefield",
  secret: MASK,
  allowPrivateAddress: false,
  panelName: "Minefield Panel",
  events: {
    "instance.crashed": true,
    "instance.started": false,
    "backup.failed": true,
    "group.run_failed": false
  },
  excludedInstances: ["d1::abcdef123456"],
  status: {
    queued: 1,
    sent: 7,
    failed: 2,
    dropped: 0,
    last: { at: 1700000000000, type: "instance.crashed", ok: false, error: "timeout" }
  },
  ...overrides
});

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
  });
});

let wrapper: VueWrapper<any>;
const mountIt = async () => {
  wrapper = mount(NotificationSettings, { attachTo: document.body });
  await flushPromises();
};
const find = (name: string) => wrapper.find(`[data-test="${name}"]`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ value: serverConfig() });
  mocks.put.mockImplementation(async ({ data }: any) => ({
    value: { ...data, status: serverConfig().status }
  }));
});

afterEach(() => {
  wrapper?.unmount();
  document.body.innerHTML = "";
});

describe("NotificationSettings.vue", () => {
  it("renders grouped events, excluded instance and status block", async () => {
    await mountIt();
    const text = wrapper.text();
    expect(text).toContain("TXT_CODE_notification_ui.groupInstance");
    expect(text).toContain("TXT_CODE_notification_ui.groupBackup");
    expect(text).toContain("TXT_CODE_notification_ui.groupGroup");
    expect(text).toContain("TXT_CODE_notification_ui.event_instance_crashed");
    expect(find("ev-backup.failed").exists()).toBe(true);
    expect(find("excluded-tag").text()).toBe("abcdef12");
    expect(find("status-block").text()).toContain("7");
    expect(find("status-last").text()).toContain("timeout");
  });

  it("does not show the plaintext secret and saves it masked", async () => {
    await mountIt();
    expect(wrapper.html()).not.toContain(MASK);
    await find("save-btn").trigger("click");
    await flushPromises();
    expect(mocks.put).toHaveBeenCalledTimes(1);
    expect(mocks.put.mock.calls[0][0].data.secret).toBe(MASK);
  });

  it("disables save and shows a hint when enabled without a URL", async () => {
    mocks.get.mockResolvedValue({ value: serverConfig({ url: "" }) });
    await mountIt();
    expect(find("save-btn").attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("TXT_CODE_notification_ui.urlRequired");
  });

  it("shows a webhook format hint", async () => {
    mocks.get.mockResolvedValue({
      value: serverConfig({ sinkType: "discord_webhook", url: "https://example.com/x" })
    });
    await mountIt();
    expect(wrapper.text()).toContain("TXT_CODE_notification_ui.urlWebhookFormat");
    expect(find("secret-input").exists()).toBe(false);
  });

  it("rotate asks for confirmation, then reveals the secret once with copy", async () => {
    const confirm = vi.spyOn(Modal, "confirm").mockImplementation(((opts: any) => {
      opts.onOk();
      return {} as any;
    }) as any);
    mocks.rotate.mockResolvedValue({ value: { secret: "plain-secret-xyz" } });
    await mountIt();
    await find("rotate-btn").trigger("click");
    await flushPromises();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mocks.rotate).toHaveBeenCalledTimes(1);
    expect((find("secret-plain").element as HTMLInputElement).value).toBe("plain-secret-xyz");
    await find("copy-secret").trigger("click");
    expect(mocks.toCopy).toHaveBeenCalledWith("plain-secret-xyz");
    await find("hide-secret").trigger("click");
    expect(find("secret-reveal").exists()).toBe(false);
    expect(wrapper.html()).not.toContain("plain-secret-xyz");
    confirm.mockRestore();
  });

  it("first generation needs no confirmation", async () => {
    const confirm = vi.spyOn(Modal, "confirm");
    mocks.get.mockResolvedValue({ value: serverConfig({ secret: "" }) });
    mocks.rotate.mockResolvedValue({ value: { secret: "first" } });
    await mountIt();
    await find("rotate-btn").trigger("click");
    await flushPromises();
    expect(confirm).not.toHaveBeenCalled();
    expect(find("secret-reveal").exists()).toBe(true);
    confirm.mockRestore();
  });

  it("test button runs the test and shows the result", async () => {
    mocks.test.mockResolvedValue({ value: { ok: false, error: "blocked_address" } });
    await mountIt();
    expect(find("test-btn").attributes("disabled")).toBeUndefined();
    await find("test-btn").trigger("click");
    await flushPromises();
    expect(mocks.test).toHaveBeenCalledTimes(1);
    expect(find("test-result").text()).toContain("TXT_CODE_notification_ui.testFail");
    expect(find("test-result").text()).toContain("TXT_CODE_notification_ui.err_blocked_address");
  });

  it("maps unknown test error codes to a generic message and blocks an invalid panel name", async () => {
    mocks.test.mockResolvedValue({ value: { ok: false, error: "weird_code" } });
    await mountIt();
    await find("test-btn").trigger("click");
    await flushPromises();
    expect(find("test-result").text()).toContain("TXT_CODE_notification_ui.err_unknown");
    await find("panel-name").setValue("");
    expect(find("save-btn").attributes("disabled")).toBeDefined();
  });

  it("test is disabled while there are unsaved changes", async () => {
    await mountIt();
    await find("allow-private").trigger("click");
    await flushPromises();
    expect(find("dirty-hint").exists()).toBe(true);
    expect(find("test-btn").attributes("disabled")).toBeDefined();
  });

  it("applies the instance picker result to the excluded list", async () => {
    mocks.useSelectInstances.mockResolvedValue([
      { daemonId: "d2", instanceUuid: "u2", nickname: "Survival" }
    ]);
    await mountIt();
    await find("pick-excluded").trigger("click");
    await flushPromises();
    expect(find("excluded-tag").text()).toBe("Survival");
    await find("save-btn").trigger("click");
    await flushPromises();
    expect(mocks.put.mock.calls[0][0].data.excludedInstances).toEqual(["d2::u2"]);
  });
});
