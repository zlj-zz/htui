/**
 * Reading and rewriting a region's request headers. Pure — unit-checked in
 * httpfile.selfcheck.ts. Headers are the `Name: value` lines directly after the
 * request line; they end at the first non-header line (blank, body, `# @name`).
 */
import type { HttpRequest } from './parse';

export interface Header {
  name: string;
  value: string;
}

/**
 * Header names include dots and underscores: a gRPC region carries channel
 * options as headers (`grpc.max_receive_message_length`), and classifying those
 * lines as body would corrupt the request on the next preview/edit.
 */
export const HEADER_RE = /^([A-Za-z0-9._-]+):\s?(.*)$/;

export function parseHeaders(content: string, req: HttpRequest): Header[] {
  const lines = content.split(/\r?\n/);
  const out: Header[] = [];
  for (let i = req.line; i <= req.endLine - 1; i++) {
    const match = (lines[i] ?? '').match(HEADER_RE);
    if (!match) break;
    out.push({ name: match[1], value: match[2] });
  }
  return out;
}

/** Replace the request's header block with `headers`, leaving everything else intact. */
export function withHeaders(content: string, req: HttpRequest, headers: Header[]): string {
  const lines = content.split(/\r?\n/);
  const afterRequest = req.line; // 0-based index of the line after the request line
  let end = afterRequest;
  while (end < req.endLine && HEADER_RE.test(lines[end] ?? '')) end++;
  const rendered = headers.map((h) => `${h.name}: ${h.value}`);
  return [...lines.slice(0, afterRequest), ...rendered, ...lines.slice(end)].join('\n');
}
