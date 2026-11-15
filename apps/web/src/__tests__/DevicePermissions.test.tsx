import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';

// AppSettings pulls in the store, which pulls in the API client; nothing here talks to a server.
vi.mock('../lib/api', () => ({
  api: {
    bots: vi.fn(async () => ({ bots: [], live: [] })),
    rows: vi.fn(async () => ({ generation: 0, rows: [] })),
    routines: vi.fn(async () => ({ routines: [] })),
    markRead: vi.fn(async () => ({ ok: true })),
  },
  openPopup: vi.fn(),
}));

import { AppSettings } from '../components/config/AppSettings';
import { useConfigUI } from '../configStore';
import {
  BLOCKED_MESSAGE,
  DEVICE_STORAGE_KEY,
  NO_DEVICE_MESSAGE,
  errorToMessage,
  readDeviceSelection,
  statusForError,
  writeDeviceSelection,
} from '../lib/device-permissions';

/**
 * jsdom ships no capture hardware, so every test states the `mediaDevices` it wants.
 * `Object.defineProperty` is required: `navigator.mediaDevices` is a prototype getter.
 */
function stubMediaDevices(overrides: Partial<MediaDevices> = {}): MediaDevices {
  const stub = {
    enumerateDevices: vi.fn(async () => []),
    getUserMedia: vi.fn(async () => { throw new DOMException('Permission denied', 'NotAllowedError'); }),
    getDisplayMedia: vi.fn(async () => { throw new DOMException('Permission denied', 'NotAllowedError'); }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    ...overrides,
  } as unknown as MediaDevices;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: stub });
  return stub;
}

function device(id: string, kind: MediaDeviceKind, label: string): MediaDeviceInfo {
  return { deviceId: id, kind, label, groupId: 'group-1', toJSON: () => ({ deviceId: id, kind, label }) } as MediaDeviceInfo;
}

beforeEach(() => {
  localStorage.clear();
  useConfigUI.setState({ appSettings: 'devices' });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'mediaDevices');
  useConfigUI.setState({ appSettings: null });
});

describe('device-permissions', () => {
  it('maps a NotAllowedError to the blocked message and a NotFoundError to “No device found.”', () => {
    expect(BLOCKED_MESSAGE).toBe('Blocked. Allow it in the system dialog or browser site settings.');

    expect(errorToMessage(new DOMException('Permission denied', 'NotAllowedError'))).toBe(BLOCKED_MESSAGE);
    expect(errorToMessage(new DOMException('Requested device not found', 'NotFoundError'))).toBe(NO_DEVICE_MESSAGE);

    // A denial is the one error that changes the pill to Blocked.
    expect(statusForError(new DOMException('Permission denied', 'NotAllowedError'))).toBe('blocked');
    expect(statusForError(new DOMException('Requested device not found', 'NotFoundError'))).toBe('not-requested');

    // An unnamed failure is still shown verbatim rather than swallowed into a generic sentence.
    expect(errorToMessage(new Error('The device is in use by another app.'))).toBe('The device is in use by another app.');
  });

  it('round-trips the chosen device ids through localStorage under orbit.devices', () => {
    writeDeviceSelection({ microphoneId: 'mic-2', cameraId: 'cam-1', speakerId: 'spk-3' });

    expect(JSON.parse(localStorage.getItem(DEVICE_STORAGE_KEY) ?? '{}')).toEqual({
      microphoneId: 'mic-2',
      cameraId: 'cam-1',
      speakerId: 'spk-3',
    });
    expect(readDeviceSelection()).toEqual({ microphoneId: 'mic-2', cameraId: 'cam-1', speakerId: 'spk-3' });

    // Garbage in storage must not throw on a settings page.
    localStorage.setItem(DEVICE_STORAGE_KEY, 'not json');
    expect(readDeviceSelection()).toEqual({ microphoneId: '', cameraId: '', speakerId: '' });
  });
});

describe('Devices & permissions settings page', () => {
  it('degrades every card to Unsupported when enumerateDevices fails', async () => {
    stubMediaDevices({
      enumerateDevices: vi.fn(async () => { throw new Error('blocked by policy'); }),
    });

    render(<AppSettings />);

    await waitFor(() => expect(screen.getAllByText('Unsupported')).toHaveLength(4));
    expect(screen.queryAllByText('Not requested')).toHaveLength(0);
  });

  it('renders the four cards with their action buttons and the settings nav entry', () => {
    stubMediaDevices();

    render(<AppSettings />);

    // The nav entry the user's request names, in the position after Computer.
    const nav = screen.getByRole('button', { name: 'Devices & permissions' });
    expect(nav).toBeTruthy();
    expect(nav.getAttribute('aria-current')).toBe('true');

    expect(screen.getByRole('heading', { name: 'Devices & permissions' })).toBeTruthy();

    for (const title of ['Microphone', 'Camera', 'Screen sharing', 'Speaker']) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    for (const action of ['Allow microphone', 'Allow camera', 'Allow screen share', 'Play test sound']) {
      expect(screen.getByRole('button', { name: action })).toBeTruthy();
    }

    // Three pickers (screen picks its surface in the OS dialog, so it has none).
    expect(screen.getByLabelText('Microphone device')).toBeTruthy();
    expect(screen.getByLabelText('Camera device')).toBeTruthy();
    expect(screen.getByLabelText('Speaker device')).toBeTruthy();
    expect(screen.queryByLabelText('Screen sharing device')).toBeNull();
  });

  it('fills each picker from enumerateDevices and restores the saved microphone', async () => {
    localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify({ microphoneId: 'mic-2', cameraId: '', speakerId: '' }));
    stubMediaDevices({
      enumerateDevices: vi.fn(async () => [
        device('mic-1', 'audioinput', 'MacBook Pro Microphone'),
        device('mic-2', 'audioinput', 'AirPods Microphone'),
        device('cam-1', 'videoinput', 'FaceTime HD Camera'),
        device('spk-1', 'audiooutput', 'MacBook Pro Speakers'),
      ]),
    });

    render(<AppSettings />);

    const mic = screen.getByLabelText('Microphone device') as HTMLSelectElement;
    await waitFor(() => expect(within(mic).getByRole('option', { name: 'AirPods Microphone' })).toBeTruthy());
    expect(mic.value).toBe('mic-2');
    expect(within(mic).getByRole('option', { name: 'System default' })).toBeTruthy();

    const camera = screen.getByLabelText('Camera device') as HTMLSelectElement;
    expect(within(camera).getByRole('option', { name: 'FaceTime HD Camera' })).toBeTruthy();
    // The camera has no saved choice, so it stays on the default.
    expect(camera.value).toBe('');

    const speaker = screen.getByLabelText('Speaker device') as HTMLSelectElement;
    expect(within(speaker).getByRole('option', { name: 'MacBook Pro Speakers' })).toBeTruthy();
  });
});
