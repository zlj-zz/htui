/**
 * The request as a data object — what the preview shows and what an edited
 * send runs. Variables like `{{token}}` are left unresolved on purpose: we do
 * not re-implement httpyac's template engine, and the temp file we run keeps
 * the file's preamble, so httpyac resolves them for real.
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

export function toJson(model: RequestModel): string {
  const headers: Record<string, string> = {};
  for (const h of model.headers) headers[h.name] = h.value; // ponytail: duplicate headers collapse — hand-edit if you need them
  const doc: Record<string, unknown> = { method: model.method, url: model.url, headers };
  if (model.body) doc.body = model.body;
  return JSON.stringify(doc, null, 2) + '\n';
}

export function fromJson(text: string): RequestModel {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('expected a JSON object');
  const obj = raw as Record<string, unknown>;

  if (typeof obj.method !== 'string' || !obj.method.trim()) throw new Error('"method" must be a non-empty string');
  if (typeof obj.url !== 'string' || !obj.url.trim()) throw new Error('"url" must be a non-empty string');

  const headers: Header[] = [];
  if (obj.headers !== undefined) {
    if (typeof obj.headers !== 'object' || obj.headers === null || Array.isArray(obj.headers)) {
      throw new Error('"headers" must be an object of name → value');
    }
    for (const [name, value] of Object.entries(obj.headers as Record<string, unknown>)) {
      if (typeof value !== 'string') throw new Error(`header "${name}" must be a string`);
      headers.push({ name, value });
    }
  }

  let body = '';
  if (obj.body !== undefined) {
    if (typeof obj.body !== 'string') throw new Error('"body" must be a string');
    body = obj.body;
  }

  return { method: obj.method.trim().toUpperCase(), url: obj.url.trim(), headers, body };
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
