import { createRequire } from 'node:module';

/**
 * The htui package version — one source for the banner and `--version`.
 * `../package.json` resolves to the package root both from `src/` (dev) and
 * from the bundled `dist/cli.js`.
 */
export function appVersion(): string {
  const require = createRequire(import.meta.url);
  return (require('../package.json') as { version: string }).version;
}
