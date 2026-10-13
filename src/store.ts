/**
 * The collection store: where imported OpenAPI collections live on disk, how
 * their names are validated, and the sidecar index that records provenance.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';import os from 'node:os';
import path from 'node:path';

/** Root of htui's user-level state: $HTUI_HOME > $XDG_CONFIG_HOME/htui > ~/.config/htui. */
export function htuiHome(): string {
  const override = process.env.HTUI_HOME?.trim();
  if (override) return path.resolve(override);

  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return path.join(path.resolve(xdg), 'htui');

  let home = '';
  try {
    home = os.homedir();
  } catch {
    home = ''; // stripped containers can throw; fall through to tmpdir
  }
  return path.join(home || os.tmpdir(), '.config', 'htui');
}

/** `--local` keeps collections inside the project so httpyac's config/env lookup still finds them. */
export function collectionsDir(local: boolean): string {
  return local
    ? path.join(process.cwd(), '.htui', 'collections')
    : path.join(htuiHome(), 'collections');
}

function indexPath(local: boolean): string {
  return path.join(collectionsDir(local), 'index.json');
}

// Windows reserved device names would make an unopenable file.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function sanitizeName(input: string): string {
  const name = input.trim();
  const reject = (why: string): never => {
    throw new Error(`invalid collection name "${input}": ${why}`);
  };
  if (!name) reject('empty');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) reject('only A-Za-z0-9._- allowed');
  if (name === '.' || name === '..') reject('reserved');
  if (name.startsWith('-')) reject('must not start with "-"');
  if (RESERVED.test(name)) reject('reserved device name');
  return name;
}

/** Derive a usable default name from a spec title or file name. */
export function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug || 'collection';
}

/** Explicit names are validated strictly, never silently rewritten. */
export function resolveCollectionName(explicit: string | undefined, fallback: string): string {
  return explicit?.trim() ? sanitizeName(explicit.trim()) : sanitizeName(slugify(fallback));
}

interface CollectionMeta {
  source: string;
  importedAt: string;
  endpoints: number;
}

type CollectionIndex = Record<string, CollectionMeta>;

export async function readIndex(local: boolean): Promise<CollectionIndex> {
  const file = indexPath(local);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as CollectionIndex;
  } catch (err) {
    // A missing index is fine; a corrupt one should not pass silently.
    if (!isMissing(err)) process.stderr.write(`htui: ignoring unreadable ${file}\n`);
    return {};
  }
}

export async function writeIndex(local: boolean, index: CollectionIndex): Promise<void> {
  const dir = collectionsDir(local);
  await mkdir(dir, { recursive: true });
  await writeFile(indexPath(local), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

// --- per-collection layout: collections/<name>/{<name>.http, http-client.env.json, <name>.local.http} ---

export function collectionDir(name: string, local: boolean): string {
  return path.join(collectionsDir(local), name);
}

export function collectionHttp(name: string, local: boolean): string {
  return path.join(collectionDir(name, local), `${name}.http`);
}

export function collectionEnv(name: string, local: boolean): string {
  return path.join(collectionDir(name, local), 'http-client.env.json');
}

export function isMissing(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ENOENT';
}

export type EnvVars = Record<string, string>;

/** Environment names declared in an http-client.env.json file (for the picker).
 *  `$`-prefixed keys are htui-reserved (`$headers`) — they are not environments. */
export async function readEnvNames(file: string): Promise<string[]> {
  try {
    return Object.keys(JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>).filter(
      (name) => !name.startsWith('$'),
    );
  } catch {
    return [];
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

/** Nearest-first http-client.env.json files from `startDir` up to the fs root. */
export async function findEnvFiles(startDir: string): Promise<string[]> {
  const found: string[] = [];
  let dir = path.resolve(startDir);
  for (;;) {
    const file = path.join(dir, 'http-client.env.json');
    if (await fileExists(file)) found.push(file);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/** Every environment name visible to a file in `startDir` (httpyac walks parents). */
export async function collectEnvNames(startDir: string): Promise<{ names: string[]; files: string[] }> {
  const files = await findEnvFiles(startDir);
  const names = new Set<string>();
  for (const file of files) for (const name of await readEnvNames(file)) names.add(name);
  return { names: [...names].sort(), files };
}

/** Values for `envName` from every http-client.env.json up the tree (nearest wins). */
export async function readEnvVars(startDir: string, envName: string): Promise<EnvVars> {
  const files = await findEnvFiles(startDir); // nearest-first
  const vars: EnvVars = {};
  // farthest first, so nearer files override
  for (const file of [...files].reverse()) {
    try {
      const env = JSON.parse(await readFile(file, 'utf8')) as Record<string, EnvVars>;
      for (const [key, value] of Object.entries(env[envName] ?? {})) {
        if (!key.startsWith('$') && typeof value === 'string') vars[key] = value;
      }
    } catch {
      // unreadable env files are reported by the import/merge paths
    }
  }
  return vars;
}

/**
 * Write `vars` into `envName`, filling only missing keys so a re-import never
 * clobbers a value the user edited. `forceKeys` are written regardless
 * (an explicit --base-url). Returns how many keys were added.
 */
export async function mergeEnv(
  name: string,
  local: boolean,
  envName: string,
  vars: EnvVars,
  forceKeys: string[] = [],
): Promise<number> {
  const file = collectionEnv(name, local);
  let env: Record<string, EnvVars> = {};
  try {
    env = JSON.parse(await readFile(file, 'utf8')) as Record<string, EnvVars>;
  } catch (err) {
    // A missing file is fine (start fresh); a corrupt one must NOT be silently
    // replaced — that would erase the user's variables and secrets.
    if (!isMissing(err)) {
      throw new Error(`not overwriting ${file}: it is not valid JSON`);
    }
  }
  const target = env[envName] ?? (env[envName] = {});
  const force = new Set(forceKeys);
  let added = 0;
  for (const [key, value] of Object.entries(vars)) {
    if (!(key in target)) added++;
    if (force.has(key) || !(key in target)) target[key] = value;
  }
  await mkdir(collectionDir(name, local), { recursive: true });
  await writeFile(file, `${JSON.stringify(env, null, 2)}\n`, 'utf8');
  return added;
}

// --- user-level recency: last-run order per file, so the request list's
// recent-first sort survives restart ---

export type Recency = Record<string, string[]>;

export function recencyPath(): string {
  return path.join(htuiHome(), 'recent.json');
}

export async function readRecency(): Promise<Recency> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(recencyPath(), 'utf8'));
  } catch (err) {
    // A missing file is fine; a corrupt one must not crash the TUI.
    if (!isMissing(err)) process.stderr.write(`htui: ignoring unreadable ${recencyPath()}\n`);
    return {};
  }
  const out: Recency = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [file, list] of Object.entries(raw)) {
      if (Array.isArray(list)) out[file] = list.filter((k): k is string => typeof k === 'string');
    }
  }
  return out;
}

export async function writeRecency(recency: Recency): Promise<void> {
  await mkdir(htuiHome(), { recursive: true });
  await writeFile(recencyPath(), `${JSON.stringify(recency, null, 2)}\n`, 'utf8');
}

// --- shared atomic writer + user-level state (selected env per project) ---

export async function writeFileAtomic(file: string, content: string, mode?: number): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  // Rename replaces the file: carry the original mode over or a 600 `.http`
  // (it can hold secrets) would widen to the umask default. `mode` is the
  // fallback for files that do not exist yet (env/state files hold secrets).
  let existing: number | undefined;
  try {
    existing = (await stat(file)).mode;
  } catch {
    existing = undefined;
  }
  const effective = existing ?? mode;
  try {
    await writeFile(tmp, content, effective === undefined ? 'utf8' : { encoding: 'utf8', mode: effective });
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

export interface HtuiState {
  /** scope (nearest env-file dir) → selected env name */
  env?: Record<string, string>;
}

function statePath(): string {
  return path.join(htuiHome(), 'state.json');
}

export async function readState(): Promise<HtuiState> {
  try {
    const raw = JSON.parse(await readFile(statePath(), 'utf8')) as HtuiState;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.env) return {};
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.env)) if (typeof value === 'string') env[key] = value;
    return { env };
  } catch {
    return {};
  }
}

export async function writeState(state: HtuiState): Promise<void> {
  await mkdir(htuiHome(), { recursive: true });
  await writeFileAtomic(statePath(), `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

// --- env files: interactive editing writes the one file that defines an env ---

export type EnvFileData = Record<string, Record<string, unknown>>;

/** Parsed env file, or null when missing/invalid (invalid files are never rewritten). */
export async function readEnvFile(file: string): Promise<EnvFileData | null> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw as EnvFileData;
  } catch {
    return null;
  }
}

export async function writeEnvFile(file: string, data: EnvFileData): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  // Env files hold secrets — a newly created one is owner-only.
  await writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`, 0o600);
}

/** Nearest env file that defines `envName` — where interactive edits land. */
export async function envDefiningFile(startDir: string, envName: string): Promise<string | undefined> {
  for (const file of await findEnvFiles(startDir)) {
    const data = await readEnvFile(file);
    if (data && envName in data) return file;
  }
  return undefined;
}

/** Env `$headers` for `envName`, nearest file wins per header name. */
export async function readEnvHeaders(startDir: string, envName: string): Promise<Record<string, string>> {
  const files = await findEnvFiles(startDir);
  const merged: Record<string, unknown> = {};
  for (const file of [...files].reverse()) {
    const data = await readEnvFile(file);
    const headers = data?.[envName]?.['$headers'];
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) Object.assign(merged, headers);
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) {
    const text = String(value);
    // A newline in a header value would corrupt the materialized request file.
    if (/^[A-Za-z0-9._-]+$/.test(name) && !/[\r\n]/.test(text)) out[name] = text;
  }
  return out;
}

// --- structured env editing: rows are the editable projection of one env ---

export interface EnvRow {
  kind: 'var' | 'header';
  name: string;
  value: string;
}

/** The editable projection of `envName` in `content`: string variables + `$headers`. */
export function envRowsOf(content: string, envName: string): EnvRow[] {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return [];
  }
  const env = (data[envName] ?? {}) as Record<string, unknown>;
  const vars = Object.entries(env)
    .filter((entry): entry is [string, string] => {
      const [name, value] = entry;
      return name !== '$headers' && !name.startsWith('$') && typeof value === 'string';
    })
    .map(([name, value]): EnvRow => ({ kind: 'var', name, value }));
  const raw = env.$headers;
  const headers =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.entries(raw as Record<string, unknown>).map(
          ([name, value]): EnvRow => ({ kind: 'header', name, value: String(value) }),
        )
      : [];
  return [...vars, ...headers];
}

/**
 * Rebuild the file from its rows. Everything a row could represent (string
 * variables, `$headers`) is removed first so renames and deletions cannot leave
 * orphan keys; non-string values and unknown `$`-keys survive untouched.
 */
export function envFileWithRows(content: string, envName: string, rows: EnvRow[]): string {
  const data = JSON.parse(content) as Record<string, Record<string, unknown>>;
  const env = { ...data[envName] };
  for (const [key, value] of Object.entries(env)) {
    const rowRepresentable = key !== '$headers' && !key.startsWith('$') && typeof value === 'string';
    if (rowRepresentable || key === '$headers') delete env[key];
  }
  for (const row of rows) if (row.kind === 'var') env[row.name] = row.value;
  const headers = rows.filter((r) => r.kind === 'header');
  if (headers.length) env.$headers = Object.fromEntries(headers.map((r) => [r.name, r.value]));
  return `${JSON.stringify({ ...data, [envName]: env }, null, 2)}\n`;
}
