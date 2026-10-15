/**
 * Mouse support for Ink, which does not model the mouse — and whose input
 * parser swallows unknown escape sequences, so mouse bytes never reach
 * `useInput`. We listen on stdin ourselves and hand events to subscribers.
 *
 * Reporting (`setMouse`) is turned on only while a layout wants the mouse.
 * Because reporting is on, the terminal no longer selects text on drag — hold
 * Shift (or Option in Terminal.app) to select.
 */
export interface MouseEvent {
  /** xterm encoding: 0=left, 1=middle, 2=right, 64=wheel-up, 65=wheel-down. */
  button: number;
  x: number;
  y: number;
  release: boolean;
}

export const WHEEL_UP = 64;
export const WHEEL_DOWN = 65;

const MOUSE_RE = /^\u001B?\[<(\d+);(\d+);(\d+)([Mm])$/;
const SCAN_RE = /\u001B\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Parse one SGR mouse sequence (with or without the leading ESC). */
export function parseMouse(input: string): MouseEvent | null {
  const match = input.match(MOUSE_RE);
  if (!match) return null;
  return {
    button: Number(match[1]),
    x: Number(match[2]),
    y: Number(match[3]),
    release: match[4] === 'm',
  };
}

const handlers = new Set<(event: MouseEvent) => void>();
let listening = false;
let tail = '';

/** Subscribe to mouse events from stdin. Returns the unsubscribe function. */
export function onMouse(handler: (event: MouseEvent) => void): () => void {
  handlers.add(handler);
  if (!listening && process.stdout.isTTY) {
    listening = true;
    process.stdin.on('data', (chunk: string | Buffer) => {
      // A chunk can bundle keystrokes and mouse events; keystrokes are Ink's
      // to parse, so only the mouse sequences are lifted out here. A sequence
      // split across chunks waits in `tail` for its rest.
      let buffer = tail + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      while (buffer.length) {
        SCAN_RE.lastIndex = 0;
        const match = SCAN_RE.exec(buffer);
        if (!match || match.index === undefined) break;
        const event: MouseEvent = {
          button: Number(match[1]),
          x: Number(match[2]),
          y: Number(match[3]),
          release: match[4] === 'm',
        };
        buffer = buffer.slice(match.index + match[0].length);
        // One throwing subscriber must not starve the others (or the scan).
        for (const handler of handlers) {
          try {
            handler(event);
          } catch {
            // A broken pane must not break the pointer for everyone else.
          }
        }
      }
      tail = buffer.includes('\u001B') ? buffer : '';
      if (tail.length > 64) tail = '';
    });
  }
  return () => handlers.delete(handler);
}

const OFF = '\u001B[?1000l\u001B[?1006l';
let exitHookRegistered = false;

export function setMouse(enabled: boolean): void {
  if (!process.stdout.isTTY) return;
  if (enabled && !exitHookRegistered) {
    exitHookRegistered = true;
    process.once('exit', () => process.stdout.write(OFF));
  }
  // 1000 = report button/wheel events; 1006 = SGR coordinates.
  process.stdout.write(enabled ? '\u001B[?1000h\u001B[?1006h' : OFF);
}
