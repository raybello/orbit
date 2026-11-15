import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Bot } from '@orbit/contracts';
import { PREVIEW_INTERVAL_MS, ScreenFrame, useScreenPreview } from '../components/ScreenPreview';

/**
 * jsdom has no IntersectionObserver, no image loader, no `Image.decode` and no blob URLs, so the
 * things the preview leans on are stubbed here: a viewport the test can scroll the frame in and out
 * of, a fetch that answers with a real Blob, and an Image whose decode the test settles by hand.
 */

const BOT: Pick<Bot, 'avatarShape' | 'avatarColor' | 'name'> = {
  avatarShape: 'blob',
  avatarColor: 'blue',
  name: 'Scout',
};

/** Every Image the hook makes, in order: the test resolves `onload` to "finish decoding" it. */
const awaitingDecode: FakeImage[] = [];

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private value = '';

  get src() {
    return this.value;
  }

  set src(value: string) {
    this.value = value;
    if (value) awaitingDecode.push(this);
  }
}

class FakeIntersectionObserver {
  static all: FakeIntersectionObserver[] = [];
  targets: Element[] = [];

  constructor(private readonly callback: (entries: { isIntersecting: boolean }[], observer: FakeIntersectionObserver) => void) {
    FakeIntersectionObserver.all.push(this);
  }

  observe(el: Element) {
    this.targets.push(el);
  }

  unobserve(el: Element) {
    this.targets = this.targets.filter((t) => t !== el);
  }

  disconnect() {
    this.targets = [];
  }

  takeRecords() {
    return [];
  }

  /** Move the frame into or out of the viewport, the way scrolling would. */
  scroll(intoView: boolean) {
    this.callback([{ isIntersecting: intoView }], this);
  }
}

const fetchMock = vi.fn();
let urlSeq = 0;
const createObjectURL = vi.fn(() => `blob:frame-${(urlSeq += 1)}`);
const revokeObjectURL = vi.fn();
const urlApi = URL as unknown as { createObjectURL?: typeof createObjectURL; revokeObjectURL?: typeof revokeObjectURL };
const hadCreate = urlApi.createObjectURL;
const hadRevoke = urlApi.revokeObjectURL;

/** The two stacked layers, in buffer order: slot 0, then slot 1. */
const layers = (root: HTMLElement) => Array.from(root.querySelectorAll('img')).map((img) => img.getAttribute('src'));

/** The layer on top: the frame the eye is actually on. */
const onTop = (root: HTMLElement) => root.querySelector('img.is-current')?.getAttribute('src') ?? null;

/** Let every queued microtask (fetch → blob → decode → publish) run, inside act. */
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
};

/** Finish decoding the oldest pending image, the way a browser settles onload. */
const decodeNext = async () => {
  const img = awaitingDecode.shift();
  expect(img).toBeDefined();
  await act(async () => { img?.onload?.(); });
  await flush();
};

/** One refresh: the timer fires, a still is fetched, its decode is left pending. */
const advance = async () => {
  await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_INTERVAL_MS); });
  await flush();
};

function Preview({ botId = 'bot-scout' }: { botId?: string }) {
  const preview = useScreenPreview(botId);
  return <ScreenFrame preview={preview} bot={BOT} />;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeIntersectionObserver.all = [];
  awaitingDecode.length = 0;
  urlSeq = 0;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(['png']) });
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();

  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  vi.stubGlobal('Image', FakeImage);
  // Decode has already happened by the time the frame is published, so the paint after it is one
  // frame: run it immediately rather than making the assertions race a real animation frame.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
  urlApi.createObjectURL = createObjectURL;
  urlApi.revokeObjectURL = revokeObjectURL;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (hadCreate) urlApi.createObjectURL = hadCreate;
  else delete urlApi.createObjectURL;
  if (hadRevoke) urlApi.revokeObjectURL = hadRevoke;
  else delete urlApi.revokeObjectURL;
});

describe('useScreenPreview', () => {
  it('asks for no still while the frame is out of view, and starts when it scrolls in', async () => {
    render(<Preview />);
    await flush();

    const [io] = FakeIntersectionObserver.all;
    expect(io.targets).toHaveLength(1); // the frame element the consumer was handed
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => { io.scroll(true); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/bots/bot-scout/screenshot');

    await decodeNext();

    // Out of view: the timer is gone, so nothing is fetched however long it stays there.
    await act(async () => { io.scroll(false); });
    await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_INTERVAL_MS * 3); });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Back in view: it picks up at once rather than waiting out another interval.
    await act(async () => { io.scroll(true); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the frame on screen until the next one has decoded, then swaps the layers', async () => {
    const { container } = render(<Preview />);
    await flush();
    await act(async () => { FakeIntersectionObserver.all[0].scroll(true); });
    await flush();

    // The first still is fetched but still decoding: the avatar is what is on screen.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(awaitingDecode).toHaveLength(1);
    expect(layers(container)).toEqual([]);
    expect(onTop(container)).toBeNull();

    await decodeNext();
    // Nothing is painted until the decode finished; then the first buffer holds the frame.
    expect(layers(container)).toEqual(['blob:frame-1', null]);
    expect(onTop(container)).toBe('blob:frame-1');

    // A second tick fetches the next still; until it decodes, the first frame has not moved.
    await advance();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(awaitingDecode).toHaveLength(1);
    expect(layers(container)).toEqual(['blob:frame-1', null]);
    expect(onTop(container)).toBe('blob:frame-1');

    await decodeNext();
    // The second buffer now carries the new frame, on top; the old one is still mounted beneath it.
    expect(layers(container)).toEqual(['blob:frame-1', 'blob:frame-2']);
    expect(onTop(container)).toBe('blob:frame-2');
    // The frame still on screen underneath has not been released.
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:frame-1');
  });

  it('releases the buffer it overwrote, not the frame on screen', async () => {
    const { container } = render(<Preview />);
    await flush();
    await act(async () => { FakeIntersectionObserver.all[0].scroll(true); });
    await flush();
    await decodeNext();
    await advance();
    await decodeNext();
    await advance();
    await decodeNext();

    // Third frame went into buffer 0; buffer 1 still holds the frame it replaced.
    expect(layers(container)).toEqual(['blob:frame-3', 'blob:frame-2']);
    expect(onTop(container)).toBe('blob:frame-3');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:frame-1');
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:frame-2');
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:frame-3');
  });

  it('refreshes every 2500ms', () => {
    expect(PREVIEW_INTERVAL_MS).toBe(2_500);
  });
});
