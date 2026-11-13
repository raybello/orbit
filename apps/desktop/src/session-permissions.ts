/**
 * Permission policy for every session the app creates.
 *
 * Orbit's voice features need the microphone. Everything else (camera, geolocation,
 * notifications, clipboard read, HID, …) is denied without a dialog: an unsolicited
 * permission prompt in a product like this reads as a bug.
 */

import type { Session } from 'electron';

const ALLOWED = new Set(['microphone', 'audioCapture']);

export function installPermissionHandlers(ses: Session): void {
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED.has(permission));
  });
  ses.setPermissionCheckHandler((_webContents, permission) => ALLOWED.has(permission));
}
