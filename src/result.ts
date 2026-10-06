/**
 * Result interpretation: what counts as a completed response, how httpyac's
 * three-valued test status renders, and the shape of httpyac's JSON contract.
 * Pure — unit-checked in result.selfcheck.ts.
 */

export interface TestResult {
  message?: string;
  /** httpyac: 'SUCCESS' | 'ERROR' | 'SKIPPED' */
  status?: string;
}

export interface HttpyacRequest {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpyacResponse {
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, unknown>;
  body?: unknown;
  /** The fully-resolved request httpyac actually sent. */
  request?: HttpyacRequest;
}

export interface HttpyacRequestResult {
  name?: string;
  response?: HttpyacResponse;
  duration?: number;
  testResults?: TestResult[];
  /** httpyac's stderr, attached when the request produced no response. */
  stderr?: string;
}

/** A completed request is one whose response actually carries a status code. */
export function hasResponse(response: { statusCode?: number } | null | undefined): boolean {
  return typeof response?.statusCode === 'number';
}

/** The single definition of "ok": completed, non-error status, no failing test. */
export function isOk(result: HttpyacRequestResult | null | undefined): boolean {
  const code = result?.response?.statusCode;
  return (
    hasResponse(result?.response) && (code ?? 0) < 400 && !(result?.testResults ?? []).some((t) => t.status === 'ERROR')
  );
}

export function testIcon(status: TestResult['status']): { icon: string; color: string } {
  if (status === 'SUCCESS') return { icon: '✓', color: 'green' };
  if (status === 'SKIPPED') return { icon: '·', color: 'yellow' };
  return { icon: '✗', color: 'red' }; // ERROR or unknown
}

/** Parse httpyac's `--json` output; a parse failure usually means truncation. */
export function parseSendOutput(stdout: string): HttpyacRequestResult[] {
  try {
    return (JSON.parse(stdout) as { requests?: HttpyacRequestResult[] }).requests ?? [];
  } catch {
    throw new Error('httpyac output was not valid JSON (it may have been truncated at 32 MB)');
  }
}
