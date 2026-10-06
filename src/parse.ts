/**
 * Minimal parser for `.http` / `.rest` files (httpyac / REST-Client format).
 * We only need enough to list selectable requests for the TUI; httpyac does
 * the real parsing/execution. Nothing here interprets variables or scripts.
 */

export interface HttpRequest {
  /** Region name (text after `###`), or "default" for a file without blocks. */
  name: string;
  method: string;
  url: string;
  /** 1-based line of the request line (cosmetic). */
  line: number;
}

const METHODS = [
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'TRACE',
  'CONNECT', 'GRAPHQL', 'QUERY', 'GRPC', 'WS', 'WEBSOCKET', 'SSE', 'MQTT',
];

const REQ_RE = new RegExp(`^\\s*(${METHODS.join('|')})\\s+(\\S+)`, 'i');
const NAME_RE = /^###\s*(.*)$/;

export function hasNamedBlocks(content: string): boolean {
  return /^###/m.test(content);
}

export function parseRequests(content: string): HttpRequest[] {
  const lines = content.split(/\r?\n/);
  const named = hasNamedBlocks(content);
  const out: HttpRequest[] = [];

  let blockName = 'default';
  let method: string | null = null;
  let url: string | null = null;
  let methodLine = 1;

  const flush = () => {
    // Without `###` blocks a file is a single "default" request; with blocks,
    // the preamble (globals/scripts) is not a selectable request.
    const keep = named ? blockName !== 'default' : true;
    if (method && url && keep) {
      out.push({ name: blockName, method: method.toUpperCase(), url, line: methodLine });
    }
    method = null;
    url = null;
  };

  lines.forEach((ln, i) => {
    const nm = ln.match(NAME_RE);
    if (nm) {
      flush();
      blockName = nm[1].trim() || `request@${i + 1}`;
      return;
    }
    if (!method) {
      const rm = ln.match(REQ_RE);
      if (rm) {
        method = rm[1];
        url = rm[2];
        methodLine = i + 1;
      }
    }
  });
  flush();

  return out;
}
