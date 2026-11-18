// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppTheme, THEME_KEY } from "@/types/const";

vi.mock("@/lang/i18n", () => ({
  t: (key: string) => key,
  getCurrentLang: () => "en_us",
  setLanguage: vi.fn()
}));

// Cut the heavy API import chain pulled in through @/types/const.
vi.mock("@/hooks/useInstance", () => ({ TYPE_UNIVERSAL: "universal" }));

// The store registers onMounted outside a component here; make it a no-op.
vi.mock("vue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue")>()),
  onMounted: vi.fn()
}));

vi.mock("../useLayoutConfig", () => ({
  useLayoutConfigStore: () => ({ getSettingsConfig: async () => ({}) })
}));

// createGlobalState caches a singleton per module instance, so reload the module per case.
const loadStore = async () => {
  vi.resetModules();
  const { useAppConfigStore } = await import("../useAppConfigStore");
  return useAppConfigStore();
};

describe("useAppConfigStore default theme", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to the dark theme when nothing is stored", async () => {
    const store = await loadStore();
    expect(store.currentTheme.value).toBe(AppTheme.DARK);
    expect(store.isDarkTheme.value).toBe(true);
  });

  it("keeps a stored light preference", async () => {
    window.localStorage.setItem(THEME_KEY, String(AppTheme.LIGHT));
    const store = await loadStore();
    expect(store.currentTheme.value).toBe(AppTheme.LIGHT);
    expect(store.isDarkTheme.value).toBe(false);
  });

  it("uses the Minefield orange as the primary colour", async () => {
    const store = await loadStore();
    expect(store.themeConfig.token?.colorPrimary).toBe("#ff9500");
  });
});
