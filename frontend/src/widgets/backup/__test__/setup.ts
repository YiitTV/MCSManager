import { vi } from "vitest";

/** Shared jsdom shims for ant-design-vue components. */
export function installDomShims() {
  // jsdom does not implement the pseudo-element argument used by ant-design-vue tables.
  const original = window.getComputedStyle.bind(window);
  window.getComputedStyle = ((el: Element) => original(el)) as typeof window.getComputedStyle;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
  });
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as any).ResizeObserver = (window as any).ResizeObserver ?? ResizeObserverStub;
}

export const i18nMock = {
  t: (key: string, params?: Record<string, unknown>) =>
    params
      ? key +
        " " +
        Object.entries(params)
          .map(([k, v]) => `{${k}}=${v}`)
          .join(" ")
      : key
};
