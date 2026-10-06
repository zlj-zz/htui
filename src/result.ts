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

export interface HttpyacResponse {
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, unknown>;
  body?: unknown;
}

export interface HttpyacRequestResult {
  name?: string;
  response?: HttpyacResponse;
  duration?: number;
  testResults?: TestResult[];
}

/** A completed request is one whose response actually carries a status code. */
export function hasResponse(response: { statusCode?: number } | null | undefined): boolean {
  return typeof response?.statusCode === 'number';
}

export function testIcon(status: TestResult['status']): { icon: string; color: string } {
  if (status === 'SUCCESS') return { icon: '✓', color: 'green' };
  if (status === 'SKIPPED') return { icon: '·', color: 'yellow' };
  return { icon: '✗', color: 'red' }; // ERROR or unknown
}
