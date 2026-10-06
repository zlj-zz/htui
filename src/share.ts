/**
 * Sharing a response: copy to the clipboard (OSC 52) and render a curl command.
 * Pure helpers — unit-checked in share.selfcheck.ts.
 */

export interface CurlRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Headers curl sets itself; echoing them back is noise. */
const SKIP_HEADERS = /^(content-length|accept-encoding|user-agent)$/i;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function toCurl(req: CurlRequest): string {
  const lines = [`curl -X ${req.method.toUpperCase()}`];
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    if (SKIP_HEADERS.test(key)) continue;
    lines.push(`  -H ${shellQuote(`${key}: ${value}`)}`);
  }
  if (req.body) lines.push(`  --data-raw ${shellQuote(req.body)}`);
  lines.push(`  ${shellQuote(req.url)}`);
  return lines.join(' \\\n');
}

/** OSC 52 is understood by most terminals and works over SSH. */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

/**
 * Write an OSC 52 clipboard escape. Many terminals truncate large payloads, so
 * anything past ~74 KB base64 is refused instead of silently cut.
 */
export function copyToTerminal(text: string): { ok: boolean; bytes: number } {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  if (encoded.length > 74_000) return { ok: false, bytes: text.length };
  process.stdout.write(osc52(text));
  return { ok: true, bytes: text.length };
}
