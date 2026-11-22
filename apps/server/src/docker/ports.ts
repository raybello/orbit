/** Where a screen listens, by display index. Pure, so nothing that dials a screen needs the desktop scripts. */

export interface ScreenLayout { display: string; displayNumber: number; vncPort: number; cdpPort: number }

export function screenPorts(index: number): ScreenLayout {
  if (!Number.isInteger(index) || index < 1) throw new Error(`invalid display index ${index}`);
  return { display: `:${index}`, displayNumber: index, vncPort: 5900 + index, cdpPort: 9200 + index };
}

/**
 * Chrome binds DevTools to the container's loopback whatever address it is given, so a published
 * port cannot reach it directly. socat listens on the container's own interface and passes the
 * connection on; the host publishes that port as the screen's CDP port.
 */
export function cdpBridgePort(index: number): number {
  return 9300 + index;
}
