// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { beforeAll, describe, expect, it, vi } from "vitest";
import BackupPlanEditor from "../BackupPlanEditor.vue";
import { installDomShims } from "./setup";

vi.mock("@/lang/i18n", async () => (await import("./setup")).i18nMock);
beforeAll(installDomShims);

const mountEditor = () =>
  mount(BackupPlanEditor, {
    props: {
      open: true,
      destinations: [{ id: "local", name: "Local", type: "local" as const }],
      isMinecraft: true
    },
    attachTo: document.body
  });

const clickOk = async () => {
  (document.body.querySelector(".ant-modal-footer .ant-btn-primary") as HTMLElement).click();
  await flushPromises();
};

describe("BackupPlanEditor", () => {
  it("blocks save with validation errors and shows them", async () => {
    const w = mountEditor();
    await flushPromises();
    await clickOk();
    expect(w.emitted("save")).toBeFalsy();
    expect(document.body.textContent).toContain("TXT_CODE_backup_ui.err_name");
    expect(document.body.textContent).toContain("TXT_CODE_backup_ui.err_destinations");
    w.unmount();
  });

  it("fills include/exclude from a preset and saves a valid plan", async () => {
    const w = mountEditor();
    await flushPromises();
    const radios = Array.from(
      document.body.querySelectorAll("[data-test=preset-group] input")
    ) as HTMLInputElement[];
    radios.find((r) => r.value === "minecraft-worlds-plugins-configs")!.click();
    await flushPromises();
    expect(document.body.textContent).toContain("server.properties");

    const name = document.body.querySelector("[data-test=plan-name]") as HTMLInputElement;
    name.value = "Nightly";
    name.dispatchEvent(new Event("input"));
    (w.vm as any).$.setupState.form.destinationIds = ["local"];
    await flushPromises();
    await clickOk();
    const payload = (w.emitted("save")![0][0] as any).plan;
    expect(payload.name).toBe("Nightly");
    expect(payload.preset).toBe("minecraft-worlds-plugins-configs");
    expect(payload.include).toContain("plugins");
    expect(payload.retention).toBe(7);
    expect(payload.minecraftSaveHook).toBe(true);
    w.unmount();
  });
});
