/**
 * Opening the user's editor. Line-jump flags differ per editor, and $EDITOR may
 * carry arguments (e.g. `code --wait`), so build the argv precisely.
 */
import { spawn } from 'node:child_process';

export interface EditorInvocation {
  bin: string;
  args: string[];
}

/** `+N` for the vim family, `--goto file:N` for VS Code; otherwise just the file. */
export function editorInvocation(
  file: string,
  line: number,
  env: NodeJS.ProcessEnv = process.env,
): EditorInvocation {
  const parts = (env.VISUAL || env.EDITOR || 'vi').trim().split(/\s+/).filter(Boolean);
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
