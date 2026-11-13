// react-native-sse ships plain JS, so the shape the app relies on is declared here.
// Reference: https://github.com/binaryminds/react-native-sse (1.2.x)
declare module 'react-native-sse' {
  export interface EventSourceOptions {
    headers?: Record<string, string>;
    withCredentials?: boolean;
    debug?: boolean;
    /** 0 disables the library's own reconnect loop, which this app replaces with its own backoff. */
    pollingInterval?: number;
    timeoutBeforeConnection?: number;
    lineEndingCharacter?: string;
  }

  export interface MessageEvent {
    type: 'message';
    data: string | null;
    lastEventId: string | null;
    url: string;
  }

  export interface FailureEvent {
    type: 'error' | 'exception' | 'open' | 'close';
    message?: string;
    xhrStatus?: number;
    error?: unknown;
  }

  export type EventSourceEvent = MessageEvent | FailureEvent;

  export default class EventSource<E extends string = never> {
    constructor(url: string, options?: EventSourceOptions);
    addEventListener(type: E | 'open' | 'message' | 'error' | 'close' | 'exception', listener: (event: EventSourceEvent | { type: 'message'; data: string | null }) => void): void;
    removeAllEventListeners(): void;
    close(): void;
  }
}
