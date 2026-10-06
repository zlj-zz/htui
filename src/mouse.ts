/**
 * Mouse support for Ink, which does not model the mouse itself — but Ink's key
 * parser passes unresolved escape sequences straight through to `useInput`
 * (with the leading ESC stripped), so a wheel tick arrives as `[<64;12;3M`.
 *
 * We turn on xterm SGR mouse reporting only while a list owns the keyboard and
 * turn it back off on the way out. Wheel events move the selection; because
 * reporting is on, the terminal no longer selects text on drag — hold Shift
 * (or Option in Terminal.app) to select.
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
