/**
 * Minimal parser for `.http` / `.rest` files (httpyac / REST-Client format).
 * We only need enough to list and slice requests for the TUI; httpyac does the
 * real parsing/execution. Nothing here interprets variables or scripts.
 *
 * A region's identity is `# @name x` when present, else the `### title`; an
 * unnamed `###` block is only addressable by line (verified against httpyac:
 * `--name` matches the resolved name, and an unknown name opens a prompt).
 */

export interface HttpRequest {
  /** Resolved name: `# @name` > `### title` > synthesized. */
  name: string;
  method: string;
  url: string;
  /** 1-based request line — the `--line` selector. */
  line: number;
  /** 1-based first line of the region (`###` line, or 1 for a whole-file request). */
  startLine: number;
  /** 1-based last line of the region (inclusive) — the slice boundary. */
  endLine: number;
}

export const METHODS = [
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'TRACE',
  'CONNECT', 'GRAPHQL', 'QUERY', 'GRPC', 'WS', 'WEBSOCKET', 'SSE', 'MQTT',
];

const REQ_RE = new RegExp(`^\\s*(${METHODS.join('|')})\\s+(\\S+)`, 'i');
const SEP_RE = /^#{3,}\s*(.*)$/;
const NAME_RE = /^\s*#\s*@name\s+(\S+)/i;

export function parseRequests(content: string): HttpRequest[] {
  const lines = content.split(/\r?\n/);

  // Region boundaries: each `###` starts one; a file without any is one region.
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (SEP_RE.test(line)) starts.push(i);
  });

  const regions = starts.length
    ? starts.map((start, k) => ({
        start,
        end: k + 1 < starts.length ? starts[k + 1] - 1 : lines.length - 1,
        title: (lines[start].match(SEP_RE)?.[1] ?? '').trim(),
      }))
    : [{ start: 0, end: lines.length - 1, title: '' }];

  const out: HttpRequest[] = [];
  for (const region of regions) {
    let method: string | null = null;
    let url: string | null = null;
    let line = region.start + 1;
    let atName: string | null = null;

    for (let i = region.start; i <= region.end; i++) {
      const src = lines[i] ?? '';
      const nm = src.match(NAME_RE);
      if (nm && !atName) atName = nm[1];
      if (!method) {
        const rm = src.match(REQ_RE);
        if (rm) {
          method = rm[1];
          url = rm[2];
          line = i + 1;
        }
      }
    }

    if (!method || !url) continue; // preamble / script-only region
    const name = atName || region.title || (starts.length ? `request@${region.start + 1}` : 'default');
    out.push({
      name,
      method: method.toUpperCase(),
      url,
      line,
      startLine: region.start + 1,
      endLine: region.end + 1,
    });
  }

  return out;
}
