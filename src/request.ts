/**
 * The request as a data object — what the preview shows and what an edited
 * send runs. Variables like `{{token}}` are left unresolved on purpose: we do
 * not re-implement httpyac's template engine, and the temp file we run keeps
 * the file's preamble, so httpyac resolves them for real.
 *
 * The editable/viewable form is `regionText` — the request in `.http` syntax.
 * Not JSON: a body is raw text, and JSON would force `\n` / `\"` escapes on the
 * user. `toJson` exists only as an optional read-only view.
 */
import { parseHeaders, type Header } from './httpfile';
import type { HttpRequest } from './parse';

export interface RequestModel {
  method: string;
  url: string;
  headers: Header[];
  body: string;
}

const BLANK_RE = /^\s*$/;
const HEADER_RE = /^([A-Za-z0-9-]+):\s?(.*)$/;
const REQUEST_LINE_RE = /^\s*([A-Za-z]+)\s+(\S+)\s*$/;

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

/** A JSON body is nested so it reads naturally; anything else stays a string. */
function bodyValue(body: string): unknown {
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** Read-only structured view (`J` in the preview). Not the editing format. */
export function toJson(model: RequestModel): string {
  const headers: Record<string, string> = {};
  for (const h of model.headers) headers[h.name] = h.value; // ponytail: duplicate headers collapse — hand-edit if you need them
  const doc: Record<string, unknown> = { method: model.method, url: model.url, headers };
  const value = bodyValue(model.body);
  if (value !== undefined) doc.body = value;
  return JSON.stringify(doc, null, 2) + '\n';
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
