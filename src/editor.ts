/**
 * Opening the user's editor. Line-jump flags differ per editor, and $EDITOR may
 * carry arguments (e.g. `code --wait`), so build the argv precisely.
 */
import { spawn } from 'node:child_process';

export interface EditorInvocation {
  bin: string;
  args: string[];
}

/** Split a command string on whitespace, honoring simple single/double quotes. */
export function splitCommand(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

/** `+N` for the vim family, `--goto file:N` for VS Code; otherwise just the file. */
export function editorInvocation(
  file: string,
  line: number,
  env: NodeJS.ProcessEnv = process.env,
): EditorInvocation {
  const parts = splitCommand(env.VISUAL || env.EDITOR || 'vi');
  const bin = parts[0] || 'vi';
  const base = parts.slice(1);
  const name = bin.split(/[\\/]/).pop() ?? bin;

  if (/^(code|codium|code-insiders)$/i.test(name)) {
    return { bin, args: [...base, '--goto', `${file}:${line}`] };
  }
  const lineFlag = /^(vi|vim|nvim|nano|emacs|hx|helix|micro|kak|kakoune|jed|gvim)$/i.test(name)
    ? [`+${line}`]
    : [];
  return { bin, args: [...base, ...lineFlag, file] };
}

/** Spawn the editor on the inherited terminal; resolve when it exits. */
export function openEditor(file: string, line: number, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { bin, args } = editorInvocation(file, line, env);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', () => resolve());
  });
}
