/**
 * Variable resolution for the "copy as curl" path. Pure — unit-checked in
 * vars.selfcheck.ts.
 *
 * htui never re-implements httpyac's template engine for execution, but a
 * copied curl must be callable: `{{baseUrl}}` placeholders are useless. So we
 * resolve only the two sources we can read reliably — the environment file and
 * the file's `@name = value` declarations (httpyac: file vars win over env) —
 * and report whatever is left (dynamic refs like `{{$random}}` or
 * `{{login.response…}}`) instead of silently emitting a broken command.
 */

export interface Resolved {
  text: string;
  /** Variable names that could not be resolved (still present in `text`). */
  unresolved: string[];
}

const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const DECL_RE = /^\s*@([A-Za-z_][\w.-]*)\s*=(.*)$/;

/** Every `@name = value` declaration in the file (file vars are file-global). */
export function fileVars(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(DECL_RE);
    if (match) vars[match[1]] = match[2].trim();
  }
  return vars;
}

/** Replace `{{var}}` from `vars`; chains resolve over a few passes. */
export function resolveVars(text: string, vars: Record<string, string>): Resolved {
  let out = text;
  const unresolved = new Set<string>();
  for (let pass = 0; pass < 5; pass++) {
    let replaced = false;
    out = out.replace(VAR_RE, (whole, rawName: string) => {
      const name = rawName.trim();
      const value = vars[name];
      if (value === undefined) {
        unresolved.add(name);
        return whole;
      }
      replaced = true;
      return value;
    });
    if (!replaced) break;
  }
  return { text: out, unresolved: [...unresolved] };
}
