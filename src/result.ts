/**
 * Result interpretation: what counts as a completed response, and how httpyac's
 * three-valued test status renders. Pure — unit-checked in result.selfcheck.ts.
 */

export interface TestResult {
  message?: string;
  /** httpyac: 'SUCCESS' | 'ERROR' | 'SKIPPED' */
  status?: string;
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
