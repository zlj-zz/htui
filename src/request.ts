/**
 * The request as a data object — what the preview shows and what an edited
 * send runs. Variables like `{{token}}` are left unresolved on purpose: we do
 * not re-implement httpyac's template engine, and the temp file we run keeps
 * the file's preamble, so httpyac resolves them for real.
 *
 * The editable/viewable form is `regionText` — the request in `.http` syntax.
 * Not JSON: a body is raw text, and JSON would force `\n` / `\"` escapes on the
 * user.
 */
import { HEADER_RE, parseHeaders, type Header } from './httpfile';
import type { HttpRequest } from './parse';

export interface RequestModel {
  method: string;
  url: string;
  headers: Header[];
  body: string;
}

const BLANK_RE = /^\s*$/;
export const REQUEST_LINE_RE = /^\s*([A-Za-z]+)\s+(\S+)\s*$/;

/** Where the body starts and the region ends (0-based line indices). */
function boundary(lines: string[], req: HttpRequest): { bodyStart: number; regionEnd: number } {
  const request = req.line - 1;
  const regionEnd = req.endLine - 1;
  let headerEnd = request + 1;
  while (headerEnd <= regionEnd && HEADER_RE.test(lines[headerEnd] ?? '')) headerEnd++;
  const bodyStart = BLANK_RE.test(lines[headerEnd] ?? '') ? headerEnd + 1 : headerEnd;
  return { bodyStart, regionEnd };
}

export function requestModel(content: string, req: HttpRequest): RequestModel {
  const lines = content.split(/\r?\n/);
  const { bodyStart, regionEnd } = boundary(lines, req);
  const body = lines.slice(bodyStart, regionEnd + 1).join('\n').replace(/\s+$/, '');
  return { method: req.method, url: req.url, headers: parseHeaders(content, req), body };
}

/** The request in `.http` syntax — header lines, a blank line, then the body
 *  verbatim. This is what the preview shows and what `$EDITOR` edits. */
export function regionText(model: RequestModel): string {
  const lines = [`${model.method} ${model.url}`, ...model.headers.map((h) => `${h.name}: ${h.value}`)];
  if (model.body) lines.push('', ...model.body.split('\n'));
  return lines.join('\n') + '\n';
}

/** Parse `regionText` back into a model. */
export function parseRegionText(text: string): RequestModel {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && BLANK_RE.test(lines[i])) i++;

  const head = (lines[i] ?? '').match(REQUEST_LINE_RE);
  if (!head) throw new Error('the first line must be "METHOD url"');
  const method = head[1].toUpperCase();
  const url = head[2];
  i++;

  const headers: Header[] = [];
  while (i < lines.length) {
    if (BLANK_RE.test(lines[i])) {
      i++;
      break;
    }
    const h = lines[i].match(HEADER_RE);
    if (!h) break; // not a header and not blank — the body starts here
    headers.push({ name: h[1], value: h[2] });
    i++;
  }

  const body = lines.slice(i).join('\n').replace(/\s+$/, '');
  return { method, url, headers, body };
}

/**
 * Preamble + the (possibly edited) target region, nothing after — the `.http`
 * we hand to httpyac. The `###` / `# @name` lines sit *above* the request line,
 * so they survive in `head` and keep the region separated (and addressable).
 */
export function modelSlice(content: string, req: HttpRequest, model: RequestModel): string {
  const head = content.split(/\r?\n/).slice(0, req.line - 1);
  const body = model.body ? ['', ...model.body.split('\n')] : [];
  return [
    ...head,
    `${model.method} ${model.url}`,
    ...model.headers.map((h) => `${h.name}: ${h.value}`),
    ...body,
  ].join('\n') + '\n';
}

/**
 * Write `model` back over the target region, in place. Everything above the
 * request line (the `###` / `# @name` preamble and any comments) and every line
 * after the region are preserved, including the blank lines that separate this
 * region from the next `###`. This is the in-place preview edit's one write path.
 */
export function replaceRegion(content: string, req: HttpRequest, model: RequestModel): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const start = req.line - 1; // 0-based request line; the preamble stays above it
  const end = req.endLine - 1; // 0-based last line of the region
  // Trailing blank lines belong to this region (the parser ends it right before
  // the next `###`) — keep them, or the next region would glue onto the body.
  let contentEnd = end;
  while (contentEnd >= start && BLANK_RE.test(lines[contentEnd] ?? '')) contentEnd--;
  const trailing = lines.slice(contentEnd + 1, end + 1);
  const region = regionText(model).replace(/\n$/, '').split('\n');
  return [...lines.slice(0, start), ...region, ...trailing, ...lines.slice(end + 1)].join(eol);
}

/** Append a region for `model` (with `### name` + `# @name`) to `content`.
 *  Pure — the file writer lives with the caller. */
export function appendRegion(content: string, model: RequestModel, name: string): string {
  const region = [`### ${name}`, `# @name ${name}`, ...regionText(model).trimEnd().split('\n')].join('\n');
  const base = content.replace(/\s+$/, '');
  return base ? `${base}\n\n${region}\n` : `${region}\n`;
}

/**
 * The headers that actually go out: request headers first, then env `$headers`
 * that are not overridden. A same-name request header always wins
 * (case-insensitive) — the file is truth, the env is a fallback.
 */
export function mergeEnvHeaders(model: RequestModel, envHeaders: Record<string, string>): RequestModel {
  const declared = new Set(model.headers.map((h) => h.name.toLowerCase()));
  const injected = Object.entries(envHeaders)
    .filter(([name]) => !declared.has(name.toLowerCase()))
    .map(([name, value]) => ({ name, value }));
  return { ...model, headers: [...model.headers, ...injected] };
}
