/**
 * Device capabilities, saved device choices and the copy shown in Settings → Devices & permissions.
 *
 * Deliberately free of React: every branch here is decided by what the browser exposes, so a
 * jsdom test can prove that a browser with no `mediaDevices` (and one whose enumeration throws)
 * degrades to "Unsupported" instead of crashing a settings page. The component only renders.
 */

/** The four cards on the page. `screen` and `speaker` have no input device to list. */
export type DeviceKind = 'microphone' | 'camera' | 'screen' | 'speaker';

/** What the status pill says. `not-requested` also covers "asked, and it did not work" without a blocked prompt. */
export type DeviceStatus = 'not-requested' | 'allowed' | 'blocked' | 'unsupported';

export interface DeviceSelection {
  microphoneId: string;
  cameraId: string;
  speakerId: string;
}

/** The localStorage key the desktop shell and a later call both read. Value: a JSON `DeviceSelection`. */
export const DEVICE_STORAGE_KEY = 'orbit.devices';

export const EMPTY_DEVICE_SELECTION: DeviceSelection = { microphoneId: '', cameraId: '', speakerId: '' };

export const BLOCKED_MESSAGE = 'Blocked. Allow it in the system dialog or browser site settings.';
export const NO_DEVICE_MESSAGE = 'No device found.';

export type PermissionStateName = 'granted' | 'denied' | 'prompt';

/** `navigator.mediaDevices`, or null when the page is not allowed to capture at all. */
export function mediaDevices(): MediaDevices | null {
  try {
    const md = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    return md && typeof md.getUserMedia === 'function' ? md : null;
  } catch {
    return null;
  }
}

export function canListDevices(): boolean {
  const md = mediaDevices();
  return !!md && typeof md.enumerateDevices === 'function';
}

/** Screen capture is a separate entry point; Chrome exposes it, Safari 13+ does, jsdom does not. */
export function canShareScreen(): boolean {
  const md = mediaDevices();
  return !!md && typeof md.getDisplayMedia === 'function';
}

/** The Web Audio constructor, including Safari's old prefix. Null in jsdom and in a locked-down frame. */
export function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  const standard = typeof AudioContext !== 'undefined' ? AudioContext : null;
  return standard ?? w.webkitAudioContext ?? null;
}

export function canPlayAudio(): boolean {
  return audioContextCtor() !== null;
}

/** The pill text. Kept here so the tests and the page cannot drift apart. */
export function statusLabel(status: DeviceStatus): string {
  switch (status) {
    case 'allowed':
      return 'Allowed';
    case 'blocked':
      return 'Blocked';
    case 'unsupported':
      return 'Unsupported';
    case 'not-requested':
    default:
      return 'Not requested';
  }
}

/**
 * Turn a rejected `getUserMedia`/`getDisplayMedia` call into something a person can act on.
 *
 * The browser error names are the contract: NotAllowedError is a decision somewhere (the OS
 * dialog or the site settings), NotFoundError is empty hardware, everything else is worth
 * showing verbatim when the message is not empty.
 */
export function errorToMessage(err: unknown): string {
  const name = (err as { name?: string } | null | undefined)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return BLOCKED_MESSAGE;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return NO_DEVICE_MESSAGE;
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The device is in use by another app.';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'That device is not available any more. Pick another one.';
    case 'NotSupportedError':
      return 'This build of Orbit cannot do that.';
    default: {
      const message = (err as { message?: string } | null | undefined)?.message?.trim();
      return message ? message : 'Something went wrong. Try again.';
    }
  }
}

/** A denial is a decision and gets the Blocked pill; anything else stays "Not requested". */
export function statusForError(err: unknown): DeviceStatus {
  const name = (err as { name?: string } | null | undefined)?.name ?? '';
  return name === 'NotAllowedError' || name === 'SecurityError' ? 'blocked' : 'not-requested';
}

/** Map `navigator.permissions.query({name})` onto a pill. Unknown names (Safari, Firefox) return null. */
export function statusForPermission(state: PermissionStateName | null): DeviceStatus {
  if (state === 'granted') return 'allowed';
  if (state === 'denied') return 'blocked';
  return 'not-requested';
}

/**
 * `navigator.permissions.query({name: 'microphone'})` where it exists.
 *
 * Safari throws on the unknown descriptor and Firefox rejects it, so the whole thing is a
 * try/catch that answers null: the page then keeps whatever status it already had.
 */
export async function queryDevicePermission(name: 'microphone' | 'camera'): Promise<PermissionStateName | null> {
  try {
    const perms = typeof navigator === 'undefined' ? undefined : navigator.permissions;
    if (!perms || typeof perms.query !== 'function') return null;
    const result = await perms.query({ name } as unknown as PermissionDescriptor);
    const state = result?.state;
    return state === 'granted' || state === 'denied' || state === 'prompt' ? state : null;
  } catch {
    return null;
  }
}

export interface DeviceList {
  devices: MediaDeviceInfo[];
  /** False when there is no `mediaDevices` at all, or when enumeration threw. */
  supported: boolean;
}

/**
 * Enumerate once, never throw. A hardened profile, a cross-origin iframe without
 * `allow="camera; microphone"` and jsdom all end up in the `supported: false` branch.
 */
export async function listDevices(): Promise<DeviceList> {
  const md = mediaDevices();
  if (!md || typeof md.enumerateDevices !== 'function') return { devices: [], supported: false };
  try {
    const devices = await md.enumerateDevices();
    return { devices: Array.isArray(devices) ? devices : [], supported: true };
  } catch {
    return { devices: [], supported: false };
  }
}

/** The devices a card's picker may offer. Screen sharing picks its surface per share, in the OS dialog. */
export function devicesForKind(devices: MediaDeviceInfo[], kind: DeviceKind): MediaDeviceInfo[] {
  const wanted = kind === 'microphone' ? 'audioinput' : kind === 'camera' ? 'videoinput' : kind === 'speaker' ? 'audiooutput' : '';
  if (!wanted) return [];
  return devices.filter((d) => d?.kind === wanted && typeof d.deviceId === 'string');
}

/**
 * A readable name for a picker row. Labels are blank until the page has held a live track, so
 * an unpicked "Microphone 2" is more use than four identical empty rows.
 */
export function deviceLabel(device: MediaDeviceInfo, index: number, kind: DeviceKind): string {
  const label = device.label?.trim();
  if (label) return label;
  const noun = kind === 'microphone' ? 'Microphone' : kind === 'camera' ? 'Camera' : 'Speaker';
  return `${noun} ${index + 1}`;
}

/** Where the shared surface came from, as the notification in the card says it. */
export function describeDisplaySurface(track: MediaStreamTrack): string {
  const settings = (track.getSettings?.() ?? {}) as MediaTrackSettings & { displaySurface?: string };
  const surface = settings.displaySurface;
  const prefix = surface === 'window' ? 'Window' : surface === 'browser' ? 'Tab' : 'Screen';
  const label = track.label?.trim();
  return label ? `${prefix}: ${label}` : `${prefix} shared`;
}

/** Read the saved choice; anything unparsable falls back to "system default" for all three. */
export function readDeviceSelection(): DeviceSelection {
  try {
    const raw = localStorage.getItem(DEVICE_STORAGE_KEY);
    if (!raw) return { ...EMPTY_DEVICE_SELECTION };
    const parsed = JSON.parse(raw) as Partial<DeviceSelection> | null;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    return {
      microphoneId: str(parsed?.microphoneId),
      cameraId: str(parsed?.cameraId),
      speakerId: str(parsed?.speakerId),
    };
  } catch {
    return { ...EMPTY_DEVICE_SELECTION };
  }
}

/** Persist the choice. Private mode and a full quota both just leave the previous value in place. */
export function writeDeviceSelection(selection: DeviceSelection): void {
  try {
    const value: DeviceSelection = {
      microphoneId: selection.microphoneId ?? '',
      cameraId: selection.cameraId ?? '',
      speakerId: selection.speakerId ?? '',
    };
    localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* the picker still works for this visit */
  }
}
