// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDestinationFormState,
  destinationFormToPayload,
  destinationToFormState,
  validateDestinationForm
} from "@/hooks/useBackupDestinationForm";
import { BACKUP_SECRET_MASK, type BackupDestination } from "@/types/backup";
import BackupDestinationForm from "../BackupDestinationForm.vue";
import { installDomShims } from "./setup";

vi.mock("@/lang/i18n", async () => (await import("./setup")).i18nMock);
beforeAll(installDomShims);

const savedS3: BackupDestination = {
  id: "d1",
  type: "s3",
  name: "R2",
  config: {
    endpoint: "https://s3.example.com",
    region: "auto",
    bucket: "my-bucket",
    pathStyle: true,
    allowPrivateNetwork: false,
    accessKeyId: "AKIA1234"
  },
  secrets: { secretAccessKey: BACKUP_SECRET_MASK }
};

describe("destination form state", () => {
  it("never holds a stored secret; resubmits the mask when untouched", () => {
    const state = destinationToFormState(savedS3);
    expect(state.secretInputs.secretAccessKey).toBe("");
    expect(validateDestinationForm(state)).toEqual({});
    const payload = destinationFormToPayload(state);
    expect(payload.secrets.secretAccessKey).toBe(BACKUP_SECRET_MASK);
    expect(payload.id).toBe("d1");
  });

  it("sends a newly typed secret instead of the mask", () => {
    const state = destinationToFormState(savedS3);
    state.secretInputs.secretAccessKey = "new-secret";
    expect(destinationFormToPayload(state).secrets.secretAccessKey).toBe("new-secret");
  });

  it("requires a secret on create", () => {
    const state = createDestinationFormState();
    Object.assign(state, {
      type: "s3",
      name: "x",
      endpoint: "https://s3.example.com",
      bucket: "my-bucket",
      accessKeyId: "AKIA1234"
    });
    expect(validateDestinationForm(state).secretAccessKey).toBeTruthy();
    expect(destinationFormToPayload(state).secrets.secretAccessKey).toBe("");
  });

  it("validates Google Drive service account JSON and keeps the stored one when blank", () => {
    const state = createDestinationFormState();
    Object.assign(state, {
      type: "gdrive",
      name: "Drive",
      authMethod: "service_account",
      folderId: "1AbCdEfGhIjKl"
    });
    expect(validateDestinationForm(state).serviceAccountJson).toBeTruthy();
    state.secretInputs.serviceAccountJson = "{not json";
    expect(validateDestinationForm(state).serviceAccountJson).toBeTruthy();
    state.secretInputs.serviceAccountJson = JSON.stringify({
      client_email: "sa@proj.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nabc"
    });
    expect(validateDestinationForm(state)).toEqual({});

    const saved = destinationToFormState({
      id: "g1",
      type: "gdrive",
      name: "Drive",
      config: { authMethod: "service_account", folderId: "1AbCdEfGhIjKl" },
      secrets: { serviceAccountJson: BACKUP_SECRET_MASK }
    });
    expect(validateDestinationForm(saved)).toEqual({});
    expect(destinationFormToPayload(saved).secrets.serviceAccountJson).toBe(BACKUP_SECRET_MASK);
  });

  it("never sends the OAuth refresh token (the panel keeps it)", () => {
    const saved = destinationToFormState({
      id: "g2",
      type: "gdrive",
      name: "Drive",
      config: { authMethod: "oauth", clientId: "abc.apps.googleusercontent.com" },
      secrets: { clientSecret: BACKUP_SECRET_MASK, refreshToken: BACKUP_SECRET_MASK }
    });
    const payload = destinationFormToPayload(saved);
    expect(payload.secrets).toEqual({ clientSecret: BACKUP_SECRET_MASK });
  });
});

describe("BackupDestinationForm.vue", () => {
  const mountForm = (destination?: BackupDestination) =>
    mount(BackupDestinationForm, {
      props: { open: true, destination },
      attachTo: document.body
    });

  it("shows the secret as a masked password input with a keep placeholder, never the value", async () => {
    const w = mountForm(savedS3);
    await flushPromises();
    const input = document.body.querySelector("[data-test=s3-secret]") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("TXT_CODE_backup_ui.secretKeep");
    expect(document.body.innerHTML).not.toContain(BACKUP_SECRET_MASK);
    w.unmount();
  });

  it("emits a save payload with the mask when the secret is untouched", async () => {
    const w = mountForm(savedS3);
    await flushPromises();
    (document.body.querySelector("[data-test=save-btn]") as HTMLElement).click();
    await flushPromises();
    const emitted = w.emitted("save");
    expect(emitted).toBeTruthy();
    expect((emitted![0][0] as BackupDestination).secrets.secretAccessKey).toBe(BACKUP_SECRET_MASK);
    w.unmount();
  });

  it("shows a warning when private network access is enabled and blocks invalid input", async () => {
    const w = mountForm();
    await flushPromises();
    (document.body.querySelector("[data-test=save-btn]") as HTMLElement).click();
    await flushPromises();
    expect(w.emitted("save")).toBeFalsy();
    w.unmount();

    const w2 = mountForm(savedS3);
    await flushPromises();
    expect(document.body.querySelector("[data-test=s3-private-warning]")).toBeNull();
    (document.body.querySelector("[data-test=s3-private]") as HTMLElement).click();
    await flushPromises();
    expect(document.body.querySelector("[data-test=s3-private-warning]")).toBeTruthy();
    w2.unmount();
  });
});

describe("Google OAuth destination", () => {
  it("requires the panel public URL and sends it with the config", () => {
    const state = createDestinationFormState();
    Object.assign(state, {
      type: "gdrive",
      name: "Drive",
      authMethod: "oauth",
      clientId: "abc.apps.googleusercontent.com",
      redirectBaseUrl: "http://example.com"
    });
    state.secretInputs.clientSecret = "cs";
    expect(validateDestinationForm(state).redirectBaseUrl).toBeTruthy();
    state.redirectBaseUrl = "https://panel.example.com";
    expect(validateDestinationForm(state)).toEqual({});
    expect(destinationFormToPayload(state).config.redirectBaseUrl).toBe(
      "https://panel.example.com"
    );
  });
});
