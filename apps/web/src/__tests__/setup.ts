// jsdom has no layout, so it ships no ResizeObserver; every browser Orbit runs in does.
class NoLayoutResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoLayoutResizeObserver as unknown as typeof ResizeObserver;
