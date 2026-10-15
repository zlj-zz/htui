#!/usr/bin/env node
import { Box, Text, render, useApp, useInput, useStdout } from 'ink';
import { Spinner } from '@inkjs/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { isStaleGeneration, noticeTtl, type Notice, type NoticeKind } from './notice';
import { parseRequests, type HttpRequest } from './parse';
import { hasResponse, isOk, testIcon, type HttpyacRequestResult, type TestResult } from './result';
import { httpyacOnPath, HTTPYAC_INSTALL_HINT, isAbort, runRequest, runTempSlice } from './run';
import { buildWorkspace, listFiles, type IndexedRequest, type ScannedFile } from './workspace';
import {
  collectEnvNames,
  envDefiningFile,
  findEnvFiles,
  isMissing,
  readEnvFile,
  readEnvHeaders,
  readEnvVars,
  readRecency,
  readState,
  writeFileAtomic,
  writeEnvFile,
  writeRecency,
  writeState,
  type Recency,
} from './store';
import { mergeEnvHeaders, modelSlice, parseRegionText, regionText, replaceRegion, requestModel, type RequestModel } from './request';
import { openEditor } from './editor';
import { copyToTerminal, toCurl } from './share';
import { importCommand, listCommand, parseFlags, printHelp, printVersion, removeCommand, sendCommand } from './commands';
import { chordOf, hintLines, resolveKey, STEPS, type Action, type Step } from './keys';
import { onMouse, setMouse, WHEEL_DOWN, WHEEL_UP, type MouseEvent } from './mouse';
import { NewRequestForm } from './ui/NewRequestForm';
import { Hints } from './ui/Hints';
import { SearchableList } from './ui/SearchableList';
import { EnvForm } from './ui/EnvForm';
import { ImportForm } from './ui/ImportForm';
import { bodyWindow, floatToTop, formatMs, jsonSpans, sparkline, truncateToWidth, urlGroup, wrapToWidth } from './rows';
import { Banner } from './ui/Banner';
import { Help } from './ui/Help';
import { HeaderForm } from './ui/HeaderForm';
import { RequestPreview } from './ui/RequestPreview';
import { fileVars, resolveVars } from './vars';

function statusColor(code?: number): string | undefined {
  if (code == null) return undefined;
  if (code < 300) return 'green';
  if (code < 400) return 'yellow';
  return 'red';
}

function TestLine({ test }: { test: TestResult }) {
  const { icon, color } = testIcon(test.status);
  return (
    <Text color={color}>
      {icon} {test.message ?? ''}
    </Text>
  );
}

function bodyText(body: unknown): string {
  if (body == null) return '';
  if (typeof body !== 'string') return JSON.stringify(body, null, 2);
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** The full response body as text (unclipped) — what y/w copy or save. */
function rawBody(result: HttpyacRequestResult | null): string {
  const body = result?.response?.body;
  if (body == null) return '';
  return typeof body === 'string' ? body : JSON.stringify(body, null, 2);
}

const relOf = (file: string) => path.relative(process.cwd(), file);
const dirOf = (p: string) => {
  const d = path.dirname(p);
  return d === '.' ? './' : `${d}/`;
};

// Imported collections live outside the project, so label them distinctly.
const fileMark = (f: ScannedFile) => (f.kind === 'generated' ? '⟳ ' : f.kind === 'local' ? '✎ ' : '');
const fileGroup = (f: ScannedFile) => `${f.source === 'collection' ? '~ imported  ' : ''}${dirOf(f.relPath)}`;
const fileHint = (f: ScannedFile) =>
  `${f.source === 'collection' ? `~ ${fileMark(f)}` : ''}${dirOf(f.relPath)}`;

// Module-level accessors: stable identities, so SearchableList's useMemo holds.
const fileKey = (f: ScannedFile) => `${f.source} ${f.relPath}`;
const fileLabel = (f: ScannedFile) => path.basename(f.file);
const reqKey = (r: HttpRequest) => `${r.method} ${r.url} ${r.name}`;
const reqLabel = (r: HttpRequest) => r.url;
const searchKey = (r: IndexedRequest) => `${r.method} ${r.url} ${r.name} ${r.relPath}`;
const searchHint = (r: IndexedRequest) => `${r.relPath}${r.name !== 'default' ? ` · ${r.name}` : ''}`;
const historyKey = (e: HistoryEntry) => `${e.method} ${e.url} ${e.name}`;
const historyLabel = (e: HistoryEntry) => e.url;

// Semantic method colors (the Postman/HTTPie convention) — identity, not decoration.
const METHOD_COLOR: Record<string, string> = {
  GET: 'green',
  POST: 'yellow',
  PUT: 'cyan',
  PATCH: 'cyan',
  DELETE: 'red',
  GRPC: 'magenta',
};
const methodLead = (method: string) => ({ text: method.padEnd(7), color: METHOD_COLOR[method] ?? 'cyan' });
const reqLead = (r: HttpRequest) => methodLead(r.method);
const searchLead = (r: IndexedRequest) => methodLead(r.method);
const historyLead = (e: HistoryEntry) => methodLead(e.method);
const historyHint = (e: HistoryEntry) => `${e.ok ? '✓' : '✗'} ${e.status ?? '?'}  ${e.name}`;
const envLabel = (n: string) => n;

/** Below this many requests a list stays flat — domain headers would be noise. */
const GROUP_THRESHOLD = 12;

/** Steps rendered as right-pane detail in the dual-pane (wide) layout. */
const SPLIT_STEPS: Step[] = ['preview', 'sending', 'result'];

type From = 'request' | 'search' | 'preview';
interface Picked {
  file: string;
  req: HttpRequest;
}

interface HistoryEntry {
  picked: Picked;
  method: string;
  url: string;
  name: string;
  ok: boolean;
  status?: number;
  duration?: number;
}

function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const stream = stdout as unknown as {
    columns?: number;
    rows?: number;
    on?: (ev: string, cb: () => void) => unknown;
    off?: (ev: string, cb: () => void) => unknown;
  };
  const read = () => ({ columns: stream.columns ?? 80, rows: stream.rows ?? 24 });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const onUpdate = () => setSize(read());
    stream.on?.('resize', onUpdate);
    return () => {
      stream.off?.('resize', onUpdate);
    };
  }, [stream]);
  return size;
}

const SCREEN_LABEL: Record<Step, string> = {
  file: 'files',
  request: 'requests',
  search: 'search',
  import: 'import',
  new: 'new',
  env: 'env',
  'env-vars': 'env vars',
  headers: 'headers',
  'pick-headers': 'headers',
  preview: 'preview',
  sending: 'sending',
  result: 'result',
  history: 'history',
  help: 'help',
  error: 'error',
};

/** Tier-1 chrome: file/env/count context strip shown above every content screen. */
function TopBar({ file, env, count, columns }: { file: string; env: string; count: number | null; columns: number }) {
  const right = count != null ? ` ${count} requests` : '';
  return (
    <Box>
      <Box width={Math.max(20, columns - right.length)}>
        <Text wrap="truncate-end">
          <Text bold color="cyan">htui</Text>
          <Text dimColor> · </Text>
          {relOf(file)}
          <Text dimColor> · </Text>
          <Text color="cyan">env:{env}</Text>
        </Text>
      </Box>
      {right ? <Text dimColor>{right}</Text> : null}
    </Box>
  );
}

/** Tier-1 chrome: current screen, selected request, and the last response, always visible. */
function StatusBar({
  step,
  picked,
  result,
  focus,
  notice,
  columns,
}: {
  step: Step;
  picked: Picked | null;
  result: HttpyacRequestResult | null;
  focus?: 'list' | 'detail';
  notice?: Notice | null;
  columns: number;
}) {
  const timing = result?.duration != null ? formatMs(result.duration) : null;
  // The transient notice is flush right on this line: feedback without a new
  // row (a row appearing and disappearing is what made frames drift). Notice
  // copy is ASCII, so .length is the display width.
  const badge = notice ? `${notice.kind === 'warn' ? '▲' : '●'} ${notice.text}` : '';
  const shown = badge.length > columns - 24 ? truncateToWidth(badge, columns - 24) : badge;
  return (
    <Box flexDirection="column">
      <Text dimColor>{'─'.repeat(Math.max(8, columns))}</Text>
      <Box>
        <Box width={columns - shown.length}>
          <Text wrap="truncate-end">
            <Text bold>{SCREEN_LABEL[step] ?? step}</Text>
        {focus ? (
          <>
            <Text dimColor> · </Text>
            <Text color="cyan">focus {focus}</Text>
          </>
        ) : null}
        {picked ? (
          <>
            <Text dimColor> · </Text>
            <Text>{picked.req.name !== 'default' ? picked.req.name : `${picked.req.method} ${picked.req.url}`}</Text>
          </>
        ) : null}
        {result ? (
          <>
            <Text dimColor> · </Text>
            {hasResponse(result.response) ? (
              <>
                <Text color={statusColor(result.response?.statusCode)}>
                  {`${result.response?.statusCode} ${result.response?.statusMessage ?? ''}`.trim()}
                </Text>
                {timing ? <Text dimColor> {timing}</Text> : null}
              </>
            ) : (
              <Text color="red">failed{timing ? ` ${timing}` : ''}</Text>
            )}
          </>
        ) : null}
          </Text>
        </Box>
        {shown ? <Text color={notice?.kind === 'warn' ? 'yellow' : 'cyan'}>{shown}</Text> : null}
      </Box>
    </Box>
  );
}

export function App({ initialFile, initialNew, into }: { initialFile?: string; initialNew?: boolean; into?: string }) {
  const { exit, suspendTerminal } = useApp();
  const [step, setStep] = useState<Step>(initialNew ? 'new' : 'file');
  const [files, setFiles] = useState<ScannedFile[] | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const { columns, rows: terminalRows } = useTerminalSize();
  const wide = columns >= 100 && file !== null;
  const narrow = !wide;
  const [focus, setFocus] = useState<'list' | 'detail'>('list');
  const [detailFile, setDetailFile] = useState<string | null>(null);
  // `detailInSplit`: the open detail came from this file's list (not from search).
  const [detailInSplit, setDetailInSplit] = useState(false);
  const [previewEditing, setPreviewEditing] = useState(false);
  // The real split predicate — NOT `wide` alone: a cross-file or search-origin
  // detail renders single-column even in a wide terminal.
  const showSplit =
    wide && (step === 'request' || (SPLIT_STEPS.indexOf(step) >= 0 && detailFile === file && detailInSplit));
  const [requests, setRequests] = useState<HttpRequest[] | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [fileEnvHeaders, setFileEnvHeaders] = useState<Record<string, string>>({});
  const [highlighted, setHighlighted] = useState<HttpRequest | null>(null);
  const [workspace, setWorkspace] = useState<IndexedRequest[] | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  /** First body row shown in the detail pane (j/k). Reset per response. */
  const [detailScroll, setDetailScroll] = useState(0);
  const [origin, setOrigin] = useState<From>('request');
  const [searchFrom, setSearchFrom] = useState<'file' | 'request'>('request');
  const [importReturn, setImportReturn] = useState<'file' | 'request'>('file');
  const [activeEnv, setActiveEnv] = useState(process.env.HTUI_ENV ?? 'default');
  const [envReturn, setEnvReturn] = useState<'file' | 'request'>('request');
  const [envFile, setEnvFile] = useState('');
  const [envNames, setEnvNames] = useState<string[] | null>(null);
  const [envVarsCtx, setEnvVarsCtx] = useState<{ file: string; envName: string; content: string } | null>(null);
  const [envVarsReturn, setEnvVarsReturn] = useState<Step>('env');
  const [envAdding, setEnvAdding] = useState(false);
  const [envNameInput, setEnvNameInput] = useState('');
  const [envDeleteArm, setEnvDeleteArm] = useState<string | null>(null);
  const [headerCtx, setHeaderCtx] = useState<{ file: string; content: string; req: HttpRequest } | null>(null);
  const [headerReturn, setHeaderReturn] = useState<Step>('request');
  const [preview, setPreview] = useState<{
    file: string;
    req: HttpRequest;
    model: RequestModel;
    envHeaders: Record<string, string>;
    edited: boolean;
    error: string;
  } | null>(null);
  const [previewReturn, setPreviewReturn] = useState<Step>('request');
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<HttpyacRequestResult | null>(null);
  const [showHeaders, setShowHeaders] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeGen = useRef(0);

  /** Feedback policy: acknowledgements fade, warnings stay until the next action. */
  function showNotice(text: string, kind: NoticeKind = 'info') {
    const generation = (noticeGen.current += 1);
    setNotice({ text, kind });
    const ttl = noticeTtl(kind);
    if (ttl === null) return;
    setTimeout(() => {
      if (!isStaleGeneration(generation, noticeGen.current)) setNotice(null);
    }, ttl);
  }

  /** Fire-and-forget with a visible failure — a dead write must not kill the TUI. */
  function attempt(promise: Promise<unknown>, what: string) {
    promise.catch((err: unknown) => showNotice(`${what}: ${err instanceof Error ? err.message : String(err)}`, 'warn'));
  }
  const [bodySearching, setBodySearching] = useState(false);
  const [bodyQuery, setBodyQuery] = useState('');

  // Render-side memo: parsing/pretty-printing a body on every keypress is wasteful.
  const bodyLines = useMemo(() => bodyText(result?.response?.body).split('\n'), [result]);
  const bodyMatches = useMemo(() => {
    const query = bodyQuery.trim().toLowerCase();
    return query ? bodyLines.filter((line) => line.toLowerCase().includes(query)) : bodyLines;
  }, [bodyLines, bodyQuery]);
  const bodyView = useMemo(() => bodyMatches.join('\n'), [bodyMatches]);
  const bodyIsJson = useMemo(() => {
    const body = result?.response?.body;
    if (body == null) return false;
    if (typeof body !== 'string') return true;
    try {
      JSON.parse(body);
      return true;
    } catch {
      return false;
    }
  }, [result]);


  const headersView = useMemo(
    () => (result?.response?.headers ? JSON.stringify(result.response.headers, null, 2) : ''),
    [result],
  );
  const [history, setHistory] = useState<HistoryEntry[]>([]);
// Response-time trend per request (this session), for the list sparkline.
  const trends = useMemo(() => {
    const values = new Map<string, number[]>();
    for (const e of [...history].reverse()) {
      if (e.duration == null) continue;
      const key = `${e.method} ${e.url} ${e.name}`;
      const list = values.get(key) ?? [];
      list.push(e.duration);
      values.set(key, list);
    }
    const map = new Map<string, { bars: string; last: number }>();
    for (const [key, list] of values) map.set(key, { bars: sparkline(list), last: list[list.length - 1] });
    return map;
  }, [history]);

  // Last-run order per file, persisted to ~/.config/htui/recent.json so the
  // recent-first sort survives restart.
  const [recency, setRecency] = useState<Recency>({});
  const recencyDirty = useRef(false);

  // Restore the persisted sort on launch; best-effort, never blocks the UI.
  useEffect(() => {
    void readRecency().then(setRecency);
  }, []);

  // Persist only after a real run — never on load, which would rewrite the file.
  useEffect(() => {
    if (!recencyDirty.current) return;
    recencyDirty.current = false;
    void writeRecency(recency).catch(() => {});
  }, [recency]);

  // Requests run most recently float to the top (recent group); the rest keep
  // file order.
  const recentRun = useMemo(() => {
    const last = new Map<string, number>();
    (file ? recency[file] ?? [] : []).forEach((key, i) => last.set(key, i));
    return last;
  }, [recency, file]);
  const requestItems = useMemo(() => {
    if (!requests) return requests;
    // Recently-run requests float to the top; grouped lists pin domain blocks
    // in one stable (alphabetical) order so they don't reshuffle after a run.
    const floated = floatToTop(requests, (r) => recentRun.get(`${r.method} ${r.url} ${r.name}`) ?? Number.MAX_SAFE_INTEGER);
    if (floated.length <= GROUP_THRESHOLD) return floated;
    return floated
      .map((r, index) => ({
        r,
        index,
        group: recentRun.has(`${r.method} ${r.url} ${r.name}`) ? 'recent' : r.group ?? urlGroup(r.url),
      }))
      .sort(
        (a, b) =>
          (a.group === 'recent' ? '' : a.group).localeCompare(b.group === 'recent' ? '' : b.group) ||
          a.index - b.index,
      )
      .map((x) => x.r);
  }, [requests, recentRun]);
  const requestGroup = useMemo(
    () =>
      (r: HttpRequest) => {
        if (recentRun.has(`${r.method} ${r.url} ${r.name}`)) return 'recent';
        return requests && requests.length > GROUP_THRESHOLD ? (r.group ?? urlGroup(r.url)) : undefined;
      },
    [recentRun, requests],
  );

  // The highlighted request, parsed for the dual-pane live preview.
  const highlightedModel = useMemo(
    () => (fileContent && highlighted ? requestModel(fileContent, highlighted) : null),
    [fileContent, highlighted],
  );
  const [historyReturn, setHistoryReturn] = useState<Step>('result');
  const [helpReturn, setHelpReturn] = useState<Step>('file');
  const [error, setError] = useState('');

  // Per-screen recall: last selected key + filter, restored when a list remounts
  // (screens unmount on navigation, which would otherwise reset the cursor).
  const [remember, setRemember] = useState<Partial<Record<Step, { key: string; query: string }>>>({});

  function fail(message: string) {
    setError(message);
    setStep('error');
  }

  // initial scan (re-runs on refresh, but auto-selects a file only once)
  const abortRef = useRef<AbortController | null>(null);
  const didInit = useRef(false);
  useEffect(() => {
    listFiles(process.cwd())
      .then((found) => {
        if (found.length === 0) {
          fail(`No .http / .rest files found under ${process.cwd()}`);
          return;
        }
        setFiles(found);
        if (didInit.current) return;
        didInit.current = true;
        if (initialNew) return; // creating a request — no auto-select
        if (initialFile) {
          setFile(path.resolve(initialFile));
          setStep('request');
        } else if (found.length === 1) {
          setFile(found[0].file);
          setStep('request');
        }
      })
      .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
  }, [initialFile, initialNew, refresh]);

  // parse requests when a file is chosen
  useEffect(() => {
    if (!file) return;
    setRequests(null);
    setHighlighted(null);
    readFile(file, 'utf8')
      .then((content) => {
        const reqs = parseRequests(content);
        if (reqs.length === 0) {
          fail(`No selectable requests in ${relOf(file)}`);
          return;
        }
        setRequests(reqs);
        setFileContent(content);
        void restoreEnvSelection(file);
      })
      .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
  }, [file, refresh]);

  // env `$headers` for the active env — the live pane merges them like the preview does
  useEffect(() => {
    if (!file) return;
    void readEnvHeaders(path.dirname(file), activeEnv)
      .then(setFileEnvHeaders)
      .catch(() => setFileEnvHeaders({}));
  }, [file, activeEnv]);

  // the cross-file index must not outlive an edit or an import
  useEffect(() => {
    setWorkspace(null);
  }, [refresh]);

  function record(target: Picked, res: HttpyacRequestResult | null) {
    const ok = isOk(res);
    const entry: HistoryEntry = {
      picked: target,
      method: target.req.method,
      url: target.req.url,
      name: target.req.name,
      ok,
      status: res?.response?.statusCode,
      duration: res?.duration,
    };
    setHistory((h) =>
      [entry, ...h.filter((e) => !(e.picked.file === target.file && e.picked.req.startLine === target.req.startLine))].slice(
        0,
        50,
      ),
    );

    // Keep the persisted sort in step: this request is now the most recent.
    const key = `${entry.method} ${entry.url} ${entry.name}`;
    setRecency((prev) => {
      const list = [key, ...(prev[target.file] ?? []).filter((k) => k !== key)].slice(0, 200);
      return { ...prev, [target.file]: list };
    });
    recencyDirty.current = true;
  }

  async function send(target: Picked, from: From, opts?: { model?: RequestModel }) {
    setPicked(target);
    setDetailFile(target.file);
    if (from === 'request') setDetailInSplit(true);
    setOrigin(from);
    setError('');
    setShowHeaders(false);
    setNotice(null);
    setBodyQuery('');
    setBodySearching(false);
    setStep('sending');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const envHeaders = await readEnvHeaders(path.dirname(target.file), activeEnv);
      const inject = Object.keys(envHeaders).length > 0;
      const merged = (model: RequestModel) => mergeEnvHeaders(model, envHeaders);
      let res: HttpyacRequestResult | null;
      if (opts?.model || inject) {
        // A preview-edited model and/or env $headers: materialize the preamble +
        // the rebuilt region and send exactly that one region (`--line`) — the
        // `.http` file itself is never touched.
        const content = await readFile(target.file, 'utf8');
        const base = opts?.model ?? requestModel(content, target.req);
        const slice = modelSlice(content, target.req, inject ? merged(base) : base);
        res = await runTempSlice({ file: target.file, slice, req: target.req, env: activeEnv, signal: controller.signal });
      } else {
        res = await runRequest(target.file, target.req, activeEnv, controller.signal);
      }
      setResult(res);
      record(target, res);
      if (inject) showNotice(`env headers injected (${Object.keys(envHeaders).length})`, 'info');
      setStep('result');
    } catch (err: unknown) {
      if (isAbort(err)) {
        showNotice('cancelled', 'warn');
        setStep(resultReturn());
        setFocus('list');
        return;
      }
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  // While the editor owns the terminal, mouse reporting must be off — a
  // foregrounded vim would receive the SGR bytes as garbage keystrokes.
  async function withEditorTerminal(fn: () => Promise<void>) {
    setMouse(false);
    try {
      await suspendTerminal(fn);
    } finally {
      if (showSplit) setMouse(true);
    }
  }

  async function edit(filePath: string, line: number) {
    try {
      // Hand the terminal to the editor, then repaint the TUI.
      await withEditorTerminal(() => openEditor(filePath, line));
    } catch (err: unknown) {
      fail(err instanceof Error ? err.message : String(err));
      return;
    }
    setRefresh((n) => n + 1); // re-read the file after editing
    showNotice(`reloaded ${path.basename(filePath)}`, 'info');
  }

  async function editEnv(envPath: string) {
    try {
      await withEditorTerminal(() => openEditor(envPath, 1));
    } catch (err: unknown) {
      fail(err instanceof Error ? err.message : String(err));
      return;
    }
    setRefresh((n) => n + 1);
    showNotice(`updated ${path.basename(envPath)}`, 'info');
  }

  /** `y` on the result screen: copy the response body as displayed — full and
   *  unclipped (the on-screen view may be search-filtered and capped at 200 lines). */
  function copyResponseBody() {
    const text = bodyText(result?.response?.body);
    if (!text) {
      showNotice('no response body', 'warn');
      return;
    }
    const copied = copyToTerminal(text);
    if (!copied.ok) showNotice('copy failed', 'warn');
    else showNotice(`copied response body (${copied.bytes} chars)`, 'info');
  }

  async function saveBody(result: HttpyacRequestResult) {
    const target = path.join(os.tmpdir(), `htui-body-${Date.now()}.json`);
    try {
      await writeFile(target, rawBody(result), { encoding: 'utf8', mode: 0o600 });
      showNotice(`saved ${target}`, 'info');
    } catch (err: unknown) {
      showNotice(`save failed: ${err instanceof Error ? err.message : String(err)}`, 'warn');
    }
  }

  async function openSearch(from: 'file' | 'request') {
    setSearchFrom(from);
    setStep('search');
    if (workspace) return;
    try {
      setWorkspace(await buildWorkspace(process.cwd()));
    } catch (err: unknown) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  function openImport(from: 'file' | 'request') {
    setImportReturn(from);
    setStep('import');
  }

  async function openHeaders(filePath: string, req: HttpRequest, from: Step) {
    try {
      const content = await readFile(filePath, 'utf8');
      setHeaderCtx({ file: filePath, content, req });
      setHeaderReturn(from);
      setStep('headers');
    } catch (err: unknown) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  async function openPreview(filePath: string, req: HttpRequest, from: Step) {
    setDetailFile(filePath);
    setDetailInSplit(from === 'request');
    try {
      const content = await readFile(filePath, 'utf8');
      const envHeaders = await readEnvHeaders(path.dirname(filePath), activeEnv);
      setPreview({ file: filePath, req, model: requestModel(content, req), envHeaders, edited: false, error: '' });
      setPreviewReturn(from);
      setNotice(null);
      setStep('preview');
    } catch (err: unknown) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  /** Variables a copied command can resolve: env file, then the file's own @vars. */
  async function previewVars(file: string): Promise<Record<string, string>> {
    const content = await readFile(file, 'utf8');
    return { ...(await readEnvVars(path.dirname(file), activeEnv)), ...fileVars(content) };
  }

  /** Copy as curl with variables resolved — the command must be runnable as-is. */
  async function copyPreviewCurl() {
    if (!preview) return;
    try {
      const { file, model } = preview;
      const vars = await previewVars(file);
      const envHeaders = await readEnvHeaders(path.dirname(file), activeEnv);
      const effective = mergeEnvHeaders(model, envHeaders);
      const unresolved = new Set<string>();

      const url = resolveVars(model.url, vars);
      url.unresolved.forEach((u) => unresolved.add(u));

      const headers: Record<string, string> = {};
      for (const h of effective.headers) {
        const value = resolveVars(h.value, vars);
        value.unresolved.forEach((u) => unresolved.add(u));
        headers[h.name] = value.text;
      }

      const body = model.body ? resolveVars(model.body, vars) : undefined;
      body?.unresolved.forEach((u) => unresolved.add(u));

      const res = copyToTerminal(toCurl({ method: model.method, url: url.text, headers, body: body?.text || undefined }));
      if (!res.ok) showNotice('command too large for the clipboard', 'warn');
      else if (unresolved.size) showNotice(`copied curl — unresolved: ${[...unresolved].join(', ')}`, 'warn');
      else showNotice('copied curl (may contain credentials)', 'info');
    } catch (err: unknown) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  /** Copy the request body with variables resolved. */
  async function copyPreviewBody() {
    if (!preview) return;
    try {
      const { file, model } = preview;
      if (!model.body) {
        showNotice('this request has no body', 'warn');
        return;
      }
      const resolved = resolveVars(model.body, await previewVars(file));
      const res = copyToTerminal(resolved.text);
      if (!res.ok) showNotice('copy failed', 'warn');
      else if (resolved.unresolved.length) showNotice(`copied request body — unresolved: ${resolved.unresolved.join(', ')}`, 'warn');
      else showNotice(`copied request body (${res.bytes} chars)`, 'info');
    } catch (err: unknown) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  async function editPreview() {
    if (!preview) return;
    setNotice(null);
    const tmp = path.join(os.tmpdir(), `htui-preview-${randomUUID()}.http`);
    try {
      await writeFile(tmp, regionText(preview.model), 'utf8');
      await openEditor(tmp, 1);
      const model = parseRegionText(await readFile(tmp, 'utf8'));
      setPreview((p) => (p ? { ...p, model, edited: true, error: '' } : p));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setPreview((p) => (p ? { ...p, error: message } : p));
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** Ctrl-S on the preview: write the edited region back to the `.http` file. */
  async function savePreview() {
    if (!preview) return;
    const { file, req, model } = preview;
    // A `###` line inside the body would be parsed as a new region on reload.
    if (model.body.split('\n').some((line) => /^#{3,}/.test(line))) {
      setPreview((p) => (p ? { ...p, error: 'body has a "###" line — use Ctrl-E ($EDITOR) to make this change' } : p));
      return;
    }
    try {
      const content = await readFile(file, 'utf8');
      await writeFileAtomic(file, replaceRegion(content, req, model));
      // The request line stays put, so `startLine` is stable across the rewrite.
      const next = parseRequests(await readFile(file, 'utf8')).find((r) => r.startLine === req.startLine);
      setPreview((p) =>
        p ? { ...p, req: next ?? p.req, edited: false, error: next ? '' : 'saved, but the region moved — reopen the file' } : p,
      );
      setRefresh((n) => n + 1);
      showNotice(`saved ${path.basename(file)}`, 'info');
    } catch (err: unknown) {
      setPreview((p) => (p ? { ...p, error: err instanceof Error ? err.message : String(err) } : p));
    }
  }

  // Each screen's keys are resolved by the shared map (src/keys.ts); these
  // handlers only say what a given action means *on this screen*.
  function appAction(action: Action): boolean {
    if (action === 'help') {
      openHelp(step);
      return true;
    }
    if (action === 'quit') {
      exit();
      return true;
    }
    return false;
  }

  /** Where Esc on the result screen returns to. */
  function resultReturn(): Step {
    return origin === 'search' ? 'search' : origin === 'preview' ? 'preview' : 'request';
  }

  function rememberStep(step: Step, key: string, query: string) {
    setRemember((r) => ({ ...r, [step]: { key, query } }));
  }

  function fileAction(action: Action, f?: ScannedFile) {
    if (appAction(action)) return;
    if (action === 'open' && f) {
      setFile(f.file);
      setStep('request');
    } else if (action === 'edit' && f) void edit(f.file, 1);
    else if (action === 'import') openImport('file');
    else if (action === 'env' && f) void openEnv(f.file, 'file');
    else if (action === 'search') void openSearch('file');
  }

  function requestAction(action: Action, r?: HttpRequest) {
    if (appAction(action)) return;
    // While a request is in flight the left pane is context-only: no re-send,
    // no re-open, no navigation — Esc (the sending hook) still cancels.
    if (step === 'sending') return;
    if (action === 'preview' && r && file) {
      void openPreview(file, r, 'request');
      if (!narrow) setFocus('detail'); // the list goes inert while previewing
    } else if (action === 'run' && r && file) void send({ file, req: r }, 'request');
    else if (action === 'headers' && r && file) void openHeaders(file, r, 'request');
    else if (action === 'edit' && r && file) void edit(file, r.line);
    else if (action === 'import') openImport('request');
    else if (action === 'env' && file) void openEnv(file, 'request');
    else if (action === 'search') void openSearch('request');
    else if (action === 'back') setStep('file');
  }

  function searchAction(action: Action, r?: IndexedRequest) {
    if (appAction(action)) return;
    if (action === 'preview' && r) void openPreview(r.file, r, 'search');
    else if (action === 'back') setStep(searchFrom);
  }

  function historyAction(action: Action, e?: HistoryEntry) {
    if (appAction(action)) return;
    if (action === 'resend' && e) void send(e.picked, 'request');
    else if (action === 'back') setStep(historyReturn);
  }

  function envAction(action: Action, name?: string) {
    if (appAction(action)) return;
    setEnvDeleteArm(null);
    if (action === 'select-env' && name) {
      setActiveEnv(name);
      attempt(persistEnvSelection(name), 'save env selection');
      setStep(envReturn);
    } else if (action === 'edit-env-vars' && name) {
      attempt(openEnvVars(envFile || file || '.', name, 'env'), 'open env editor');
    } else if (action === 'add-env') {
      setEnvNameInput('');
      setEnvAdding(true);
    } else if (action === 'delete-env' && name) {
      if (envDeleteArm === name) attempt(deleteEnv(name), 'delete env');
      else {
        setEnvDeleteArm(name);
        showNotice(`press d again to delete env "${name}"`, 'warn');
      }
    } else if (action === 'edit') void editEnv(envFile);
    else if (action === 'back') setStep(envReturn);
  }

  // The add-env name field owns the keyboard while it is up.
  useInput(
    (input, key) => {
      if (key.escape) {
        setEnvAdding(false);
        return;
      }
      if (key.return) {
        const name = envNameInput.trim();
        if (!/^[A-Za-z0-9._-]+$/.test(name)) {
          showNotice('env name: letters, digits, . _ -', 'warn');
          return;
        }
        void addEnv(name);
        return;
      }
      if (key.backspace || key.delete) setEnvNameInput((v) => v.slice(0, -1));
      else if (input) setEnvNameInput((v) => v + input.replace(/[\r\n\t]/g, ''));
    },
    { isActive: step === 'env' && envAdding },
  );

  function resultAction(action: Action) {
    if (appAction(action)) return;
    if (action === 'back' && file) {
      setResult(null);
      setError('');
      setStep(resultReturn());
      setFocus('list');
    } else if (action === 'run' && picked) void send(picked, origin);
    else if (action === 'copy-resp') copyResponseBody();
    else if (action === 'edit' && picked) void edit(picked.file, picked.req.line);
    else if (action === 'vars' && picked) {
      attempt(openEnvVars(picked.file, activeEnv, 'result'), 'open env editor');
    } else if (action === 'history') {
      setHistoryReturn('result');
      setStep('history');
    } else if (action === 'fold-headers') setShowHeaders((v) => !v);
    else if (action === 'search-body') setBodySearching(true);
    else if (action === 'save' && result) void saveBody(result);
  }

  function openHelp(from: Step) {
    setHelpReturn(from);
    setStep('help');
  }

  async function openEnv(filePath: string, from: 'file' | 'request') {
    setEnvReturn(from);
    setStep('env');
    setEnvNames(null);
    const { names, files } = await collectEnvNames(path.dirname(filePath));
    setEnvFile(files[0] ?? path.join(path.dirname(filePath), 'http-client.env.json'));
    setEnvNames(names);
    // The cursor starts on the active env, not on the first row.
    rememberStep('env', activeEnv, '');
  }

  /** The selected env survives restarts, scoped to the nearest env file's dir.
   *  Best-effort: a persistence failure here must never block the launch. */
  async function restoreEnvSelection(filePath: string) {
    try {
      if (process.env.HTUI_ENV) return;
      const files = await findEnvFiles(path.dirname(filePath));
      if (!files[0]) return;
      const saved = (await readState()).env?.[path.dirname(files[0])];
      if (saved) setActiveEnv(saved);
    } catch {
      // selection restore is cosmetic
    }
  }

  async function persistEnvSelection(name: string) {
    if (!envFile) return;
    const state = await readState();
    state.env = { ...state.env, [path.dirname(envFile)]: name };
    await writeState(state);
  }

  /** Structured editing of one env in the ONE file that defines it. */
  async function openEnvVars(filePath: string, envName: string, from: Step) {
    const dir = path.dirname(filePath);
    const target = (await envDefiningFile(dir, envName)) ?? path.join(dir, 'http-client.env.json');
    let content = '';
    let exists = false;
    try {
      content = await readFile(target, 'utf8');
      exists = true;
    } catch (err) {
      if (!isMissing(err)) {
        showNotice(`cannot read ${path.basename(target)}`, 'warn');
        return;
      }
    }
    if (exists && !(await readEnvFile(target))) {
      showNotice(`${path.basename(target)} is not valid JSON — edit it with ctrl-e`, 'warn');
      return;
    }
    if (!exists) {
      // No env file yet: seed a valid skeleton instead of editing into nothing.
      content = `${JSON.stringify({ [envName]: {} }, null, 2)}\n`;
      await writeEnvFile(target, JSON.parse(content));
    }
    setEnvVarsCtx({ file: target, envName, content });
    setEnvVarsReturn(from);
    setStep('env-vars');
  }

  async function addEnv(name: string) {
    setEnvAdding(false);
    const target = envFile || path.join(path.dirname(file ?? process.cwd()), 'http-client.env.json');
    const data = await readEnvFile(target);
    if (data === null) {
      // Only a truly absent file may be created; a corrupt one is never clobbered.
      try {
        await readFile(target);
        showNotice(`${path.basename(target)} is not valid JSON — fix it with ctrl-e first`, 'warn');
      } catch (err) {
        if (!isMissing(err)) showNotice(`cannot read ${path.basename(target)}`, 'warn');
      }
      return;
    }
    if (name in data) {
      showNotice(`env "${name}" already exists`, 'warn');
      return;
    }
    data[name] = {};
    await writeEnvFile(target, data);
    setEnvNames((await collectEnvNames(path.dirname(target))).names);
    showNotice(`added env ${name}`, 'info');
  }

  async function deleteEnv(name: string) {
    setEnvDeleteArm(null);
    const target = await envDefiningFile(path.dirname(envFile || (file ?? '.')), name);
    if (!target) {
      showNotice(`env "${name}" is not defined in any env file`, 'warn');
      return;
    }
    const data = await readEnvFile(target);
    if (!data) return;
    delete data[name];
    await writeEnvFile(target, data);
    if (activeEnv === name) {
      setActiveEnv('default');
      attempt(persistEnvSelection('default'), 'save env selection');
    }
    const { names } = await collectEnvNames(path.dirname(envFile));
    setEnvNames(names);
    showNotice(
      names.includes(name)
        ? `deleted from ${path.basename(target)} — still defined in a parent env file`
        : `deleted env ${name}`,
      names.includes(name) ? 'warn' : 'info',
    );
  }

  useInput(
    (input, key) => {
      const action = resolveKey(step, chordOf(input, key));
      if (action) resultAction(action);
    },
    { isActive: step === 'error' || (step === 'result' && !bodySearching && (!showSplit || focus === 'detail')) },
  );

  useInput(
    (input, key) => {
      const action = resolveKey('help', chordOf(input, key));
      if (action === 'quit') exit();
      else if (action === 'back' || action === 'help') setStep(helpReturn);
    },
    { isActive: step === 'help' },
  );

  useInput(
    (input, key) => {
      const action = resolveKey(step, chordOf(input, key));
      if (action === 'back') cancelSend();
      else if (action === 'quit') exit();
    },
    { isActive: step === 'sending' },
  );

  useInput(
    (input, key) => {
      if (key.return) setBodySearching(false); // keep the filter
      else if (key.escape) {
        setBodyQuery('');
        setBodySearching(false);
      } else if (key.backspace || key.delete) setBodyQuery((q) => q.slice(0, -1));
      else if (input) setBodyQuery((q) => q + input.replace(/[\r\n\t]/g, ''));
    },
    { isActive: step === 'result' && bodySearching && (!showSplit || focus === 'detail') },
  );

  // Tab toggles pane focus — a layout control, deliberately handled here rather
  // than in keys.ts: GLOBAL feeds every footer/Help, and Tab only means
  // something in the dual-pane layout. Never while an inline field or the body
  // search owns the keyboard (their handlers stay active and would be orphaned).
  useInput((_input, key) => {
    if (!showSplit || bodySearching || previewEditing) return;
    if (key.tab) setFocus((f) => (f === 'list' ? 'detail' : 'list'));
  });

  // A new response starts at the top of the body.
  useEffect(() => {
    setDetailScroll(0);
  }, [picked, result]);

  // j/k scroll the response body. Only where the body is what you are looking
  // at: with the panes split that means focus on the detail pane, and in a
  // narrow terminal the result screen is the only thing on screen.
  useInput((input, key) => {
    if (step !== 'result' || bodySearching || previewEditing) return;
    if (showSplit && focus !== 'detail') return;
    // A burst of keys can arrive as one chunk (`jjj`), so count, don't match.
    const down = key.downArrow ? 1 : (input.match(/j/g) ?? []).length;
    const up = key.upArrow ? 1 : (input.match(/k/g) ?? []).length;
    if (down) setDetailScroll((n) => n + down);
    else if (up) setDetailScroll((n) => Math.max(0, n - up));
  });

  // Dual-pane mouse: the left pane's list handles its own column (click select,
  // double-click open, wheel); the right pane is handled here — wheel scrolls
  // the body, a click focuses the pane. Reporting stays on for the whole
  // layout while it is up; narrow lists toggle it themselves.
  useEffect(() => {
    if (!showSplit) return;
    setMouse(true);
    return () => setMouse(false);
  }, [showSplit]);

  const mouseRef = useRef<(event: MouseEvent) => void>(() => {});
  mouseRef.current = (event) => {
    if (!showSplit) return;
    if (event.x <= leftWidth) {
      // The list selects the row; the layout follows the pointer with focus.
      if (event.button === 0 && !event.release) setFocus('list');
      return;
    }
    if (event.button === WHEEL_UP || event.button === WHEEL_DOWN) {
      setDetailScroll((n) => Math.max(0, n + (event.button === WHEEL_UP ? -1 : 1)));
    } else if (event.button === 0 && !event.release) {
      setFocus('detail');
    }
  };
  useEffect(() => onMouse((event) => mouseRef.current(event)), []);

  function cancelSend() {
    abortRef.current?.abort();
  }

  function requestPane(chrome: boolean) {
    if (!file) return <Text color="red">No file selected.</Text>;
    if (!requests) return <Spinner label="Parsing requests…" />;
    return (
      <SearchableList
        step="request"
        isActive={chrome || focus === 'list'}
        showFooter={chrome}
        maxVisible={chrome ? undefined : Math.max(3, paneHeight - 5)}
        mousePane={chrome ? undefined : { x0: 1, x1: leftWidth, y0: 5 }}
        anchorKey={picked ? `${picked.req.method} ${picked.req.url} ${picked.req.name}` : undefined}
        onHighlight={(r) => setHighlighted(r ?? null)}
        placeholder="filter requests…"
        items={requestItems ?? []}
        keyOf={reqKey}
        labelOf={reqLabel}
        hintOf={(r) => {
          const trend = trends.get(`${r.method} ${r.url} ${r.name}`);
          const name = r.name !== 'default' ? r.name : undefined;
          return trend ? `${trend.bars} ${formatMs(trend.last)}${name ? ` · ${name}` : ''}` : name;
        }}
        noun="requests"
        leadOf={reqLead}
        groupOf={requestGroup}
        restore={remember.request}
        onRemember={(key, query) => rememberStep('request', key, query)}
        notice={notice}
        onAction={requestAction}
      />
    );
  }

  function previewPane(chrome: boolean) {
    if (!preview) return <Spinner label="Reading request…" />;
    return (
      <RequestPreview
        model={preview.model}
        envHeaders={preview.envHeaders}
        edited={preview.edited}
        error={preview.error}
        isActive={chrome || focus === 'detail'}
        showHints={chrome}
        onEditing={setPreviewEditing}
        onModel={(model) => setPreview((p) => (p ? { ...p, model, edited: true, error: '' } : p))}
        onSave={() => void savePreview()}
        onAction={(action) => {
          if (action === 'send')
            void send({ file: preview.file, req: preview.req }, 'preview', preview.edited ? { model: preview.model } : {});
          else if (action === 'edit-preview') void editPreview();
          else if (action === 'copy-body') void copyPreviewBody();
          else if (action === 'copy-curl') void copyPreviewCurl();
          else if (action === 'back') {
            setStep(previewReturn);
            setFocus('list');
          } else appAction(action);
        }}
      />
    );
  }

  function sendingPane(chrome: boolean) {
    return (
      <Box flexDirection="column">
        <Spinner label={`SENDING ${picked?.req.method} ${picked?.req.url}`} />
        {chrome ? <Hints step="sending" /> : null}
      </Box>
    );
  }

  /** Read-only preview of the highlighted request — the right pane is never empty. */
  function livePane() {
    if (!highlightedModel) {
      return (
        <Box flexDirection="column">
          <Text dimColor>REQUEST · read-only</Text>
          <Text dimColor>Select a request to see it here</Text>
        </Box>
      );
    }
    const lines = regionText(mergeEnvHeaders(highlightedModel, fileEnvHeaders)).replace(/\n$/, '').split('\n');
    const room = Math.max(1, paneHeight - 4);
    const shown = lines.slice(0, room);
    return (
      <Box flexDirection="column">
        <Text dimColor>REQUEST · read-only</Text>
        {shown.map((line, i) => (
          <Text key={i} wrap="truncate-end" dimColor={i > 0}>
            {line || ' '}
          </Text>
        ))}
        {lines.length > shown.length ? (
          <Text dimColor>… +{lines.length - shown.length} more lines · Enter to edit</Text>
        ) : null}
      </Box>
    );
  }

  function detailPane() {
    if (step === 'preview') return previewPane(false);
    if (step === 'sending') return sendingPane(false);
    if (step === 'result') return resultPane(false);
    return livePane();
  }

  function screen() {
    if (step === 'error') {
      return (
        <Box flexDirection="column">
          <Text color="red">✗ {error}</Text>
          <Hints step="error" />
        </Box>
      );
    }

    if (step === 'import') {
      return (
        <ImportForm
          onCancel={() => setStep(importReturn)}
          onAction={appAction}
          onDone={() => {
            setStep(importReturn);
            setRefresh((n) => n + 1);
          }}
        />
      );
    }

    if (step === 'env-vars') {
      if (!envVarsCtx) return <Spinner label="Reading environment…" />;
      return (
        <EnvForm
          envFile={envVarsCtx.file}
          envName={envVarsCtx.envName}
          content={envVarsCtx.content}
          notice={notice}
          onSave={async (next) => {
            await writeFileAtomic(envVarsCtx.file, next);
            setEnvVarsCtx({ ...envVarsCtx, content: next });
            setRefresh((n) => n + 1);
            showNotice(`saved ${path.basename(envVarsCtx.file)}`, 'info');
          }}
          onAction={(action) => {
            if (action === 'back') setStep(envVarsReturn);
            else appAction(action);
          }}
        />
      );
    }

    if (step === 'headers') {
      if (!headerCtx) return <Spinner label="Reading request…" />;
      return (
        <HeaderForm
          content={headerCtx.content}
          req={headerCtx.req}
          notice={notice}
          onSave={async (next) => {
            await writeFileAtomic(headerCtx.file, next);
            setHeaderCtx({ ...headerCtx, content: next });
            setRefresh((n) => n + 1);
            showNotice(`headers saved to ${path.basename(headerCtx.file)}`, 'info');
          }}
          onAction={(action) => {
            if (action === 'back') setStep(headerReturn);
            else appAction(action);
          }}
        />
      );
    }

    if (step === 'preview') return previewPane(true);

    if (step === 'new') {
      return (
        <NewRequestForm
          into={into}
          onCancel={() => setStep('file')}
          onAction={(action) => appAction(action)}
          onDone={(file, key) => {
            setFile(file);
            setRemember((r) => ({ ...r, request: { key, query: '' } }));
            setRefresh((n) => n + 1);
            setStep('request');
          }}
        />
      );
    }

    if (step === 'help') return <Help />;

    if (step === 'history') {
      return (
        <SearchableList
          step="history"
          header={`History (${history.length})  ·  env:${activeEnv}`}
          placeholder="filter history…"
          items={history}
          keyOf={historyKey}
          labelOf={historyLabel}
          hintOf={historyHint}
          noun="runs"
          leadOf={historyLead}
          restore={remember.history}
          onRemember={(key, query) => rememberStep('history', key, query)}
          notice={notice}
          onAction={historyAction}
        />
      );
    }

    if (step === 'env') {
      if (envAdding) {
        return (
          <Box flexDirection="column">
            <Text bold>Add environment · {relOf(envFile)}</Text>
            <Text dimColor>Name: letters, digits, . _ - · Esc to cancel</Text>
            <Text>
              <Text color="cyan">❯ </Text>
              {envNameInput}
              <Text color="cyan">▏</Text>
            </Text>
            {notice ? <Text color={notice.kind === 'warn' ? 'yellow' : 'cyan'}>{notice.text}</Text> : null}
          </Box>
        );
      }
      if (!envNames) return <Spinner label="Reading environments…" />;
      return (
        <SearchableList
          step="env"
          header={`Environment · ${relOf(envFile)}  (current: ${activeEnv})`}
          placeholder="filter environments…"
          items={envNames}
          keyOf={envLabel}
          labelOf={envLabel}
          noun="environments"
          restore={remember.env}
          onRemember={(key, query) => rememberStep('env', key, query)}
          notice={notice}
          onAction={envAction}
        />
      );
    }

    if (step === 'file') {
      if (!files) return <Spinner label="Scanning for .http / .rest files…" />;
      return (
        <Box flexDirection="column">
          <Banner files={files.length} />
          <SearchableList
            step="file"
            header={`Select a file — ${process.cwd()}  ·  env:${activeEnv}`}
            placeholder="filter files…"
            items={files}
            keyOf={fileKey}
            labelOf={fileLabel}
            hintOf={fileHint}
            groupOf={fileGroup}
            noun="files"
            restore={remember.file}
            onRemember={(key, query) => rememberStep('file', key, query)}
            notice={notice}
            onAction={fileAction}
          />
        </Box>
      );
    }

    if (step === 'request') return requestPane(true);

    if (step === 'search') {
      if (!workspace) return <Spinner label="Indexing requests…" />;
      return (
        <SearchableList
          step="search"
          header={`Search all requests  ·  env:${activeEnv}`}
          placeholder="search method / url / name / path…"
          items={workspace}
          keyOf={searchKey}
          labelOf={reqLabel}
          hintOf={searchHint}
          noun="requests"
          leadOf={searchLead}
          restore={remember.search}
          onRemember={(key, query) => rememberStep('search', key, query)}
          notice={notice}
          onAction={searchAction}
        />
      );
    }

    if (step === 'sending') return sendingPane(true);

    return resultPane(true);
  }

  function resultPane(chrome: boolean) {
    const response = result?.response;
    // A response without a status code means the request never completed.
    const completed = hasResponse(response);
    const tests = result?.testResults ?? [];
    // Wrap ourselves: a line the terminal wraps is a row Ink never counted, and
    // every row below it then lands at the wrong offset.
    const wrap = (text: string) => text.split('\n').flatMap((line) => wrapToWidth(line, detailWidth));
    // Everything drawn before the body: status, file, headers, the blank line,
    // and the body-search prompt while it is open.
    const headerRows = response?.headers && showHeaders ? wrap(headersView) : [];
    const headRows =
      1 + (picked ? 1 : 0) + (response?.headers ? (showHeaders ? headerRows.length : 1) : 0) + 1 + (bodySearching ? 1 : 0);
    const win = bodyWindow(bodyRows.length, detailBudget - headRows, detailScroll);
    const bodyShown = bodyRows.slice(win.offset, win.offset + win.count);
    // The failed path is clipped too — stderr can be long.
    const failRoom = Math.max(1, detailBudget - headRows + (bodySearching ? 1 : 0));
    const stderrRows = result?.stderr ? wrap(result.stderr) : [];
    const stderrShown = stderrRows.slice(0, tests.length ? Math.max(1, failRoom - tests.length) : failRoom);
    const testsShown = tests.slice(0, Math.max(1, failRoom - stderrShown.length));
    const failHidden = stderrRows.length - stderrShown.length + tests.length - testsShown.length;

    return (
      <Box flexDirection="column">
        {/* Title row: the pane's state, always first — focus lives on the border,
            so this line only has to answer "what am I looking at". */}
        <Text color={completed ? statusColor(response?.statusCode) : 'red'}>
          {truncateToWidth(
            completed
              ? `RESPONSE ${response?.statusCode} ${response?.statusMessage ?? ''}${
                  result?.duration != null ? ` · ${formatMs(result.duration)}` : ''
                }${picked ? ` · ${relOf(picked.file)}` : ''}`
              : `RESPONSE · failed${result?.duration != null ? ` · ${formatMs(result.duration)}` : ''}${
                  picked ? ` · ${relOf(picked.file)}` : ''
                }`,
            detailWidth,
          )}
        </Text>
        {picked ? (
          <Text dimColor>{truncateToWidth(`${picked.req.method} ${picked.req.url}`, detailWidth)}</Text>
        ) : null}

        {completed ? (
          <>
            {response?.headers ? (
              showHeaders ? (
                <Text dimColor>{wrap(headersView).join('\n')}</Text>
              ) : (
                <Text dimColor>▸ headers({Object.keys(response.headers).length}) · h to expand</Text>
              )
            ) : null}
            {bodySearching ? (
              <Text>
                <Text color="cyan">❯ </Text>
                {bodyQuery || <Text dimColor>filter body… (Enter keep · Esc clear)</Text>}
                <Text dimColor>{`  ${bodyMatches.length} ${bodyQuery ? 'matches' : 'lines'}`}</Text>
              </Text>
            ) : null}
            <Box marginTop={1} flexDirection="column">
              {/* shortcut: jsonSpans runs per wrapped chunk, so a string split across
                  rows can lose its colour; colour the whole line first if it bothers. */}
              {bodyIsJson
                ? bodyShown.map((line, i) => (
                    <Text key={i} wrap="truncate-end">
                      {jsonSpans(line).map((span, j) => (
                        <Text key={j} color={span.color}>
                          {span.text}
                        </Text>
                      ))}
                    </Text>
                  ))
                : <Text>{bodyShown.join('\n')}</Text>}
              {win.scrollable ? (
                <Text dimColor>{`rows ${win.offset + 1}-${win.offset + bodyShown.length} of ${bodyRows.length}  ·  j/k scroll`}</Text>
              ) : null}
            </Box>
          </>
        ) : (
          <Box marginTop={1} flexDirection="column">
            {stderrShown.length ? <Text color="red">{stderrShown.join('\n')}</Text> : null}
            {tests.length === 0 ? (
              result?.stderr ? null : <Text color="red">no response</Text>
            ) : (
              testsShown.map((t, i) => <TestLine key={i} test={t} />)
            )}
            {failHidden > 0 ? <Text dimColor>{`… (+${failHidden} more rows)`}</Text> : null}
          </Box>
        )}

        {completed && tests.length ? (
          <Box marginTop={1} flexDirection="column">
            {tests.map((t, i) => (
              <TestLine key={i} test={t} />
            ))}
          </Box>
        ) : null}

        <Box marginTop={1} flexDirection="column">
          {chrome ? <Hints step="result" /> : null}
        </Box>
      </Box>
    );
  }

  // Chrome: TopBar (1) + the packed hints (1..n rows) + StatusBar (rule + text).
  // The left pane (when it exists) owns the keys whenever it has focus.
  const hintStep: Step = step === 'sending' ? 'sending' : showSplit && focus === 'list' ? 'request' : step;
  const hintRows = Math.max(1, hintLines(hintStep, Math.max(1, columns - 1)).length);
  // Reserve the tallest screen's hint block: a pane that changes height between
  // steps shifts every row below it, and Ink then leaves stale fragments behind.
  const hintRowsMax = Math.max(...STEPS.map((s) => hintLines(s, Math.max(1, columns - 1)).length));
  const paneHeight = Math.max(6, terminalRows - 3 - hintRowsMax);
  // Rows the detail pane may draw. Ink mis-writes the rows of a fixed-height box
  // that is handed more children than it can show, so we clip before it can.
  const detailBudget = Math.max(4, showSplit ? paneHeight - 2 : terminalRows - 3);
  // Explicit pane widths: a flexGrow right pane gets stretched by long content
  // (Yoga's flexShrink defaults to 0), which skews the split ratio.
  const leftWidth = Math.max(24, Math.round((columns * 5) / 12));
  const rightWidth = Math.max(24, columns - leftWidth);
  // Inner width of whatever pane shows the detail (borders take 2 columns).
  const detailWidth = Math.max(20, (showSplit ? rightWidth : columns) - 2);
  // The body wrapped once per body/width — scrolling re-slices, not re-wraps.
  const bodyRows = useMemo(
    () => bodyView.split('\n').flatMap((line) => wrapToWidth(line, detailWidth)),
    [bodyView, detailWidth],
  );

  return (
    <Box flexDirection="column">
      {file ? (
        <>
          <TopBar file={file} env={activeEnv} count={requests?.length ?? null} columns={columns} />
          {showSplit ? (
            <>
              <Box>
                <Box
                  width={leftWidth}
                  height={paneHeight}
                  borderStyle="round"
                  borderColor={focus === 'list' ? 'cyan' : 'gray'}
                  overflow="hidden"
                  flexDirection="column"
                >
                  {/* flexShrink={0}: Yoga squeezes a fixed-height box's children
                      by default, and rounded fractional heights leave only every
                      second or third row — Ink then keeps the stale prefix. */}
                  <Box flexDirection="column" flexShrink={0}>
                    <Text dimColor>REQUESTS{requests ? ` · ${requests.length}` : ''}</Text>
                    {requestPane(false)}
                  </Box>
                </Box>
                <Box
                  width={rightWidth}
                  height={paneHeight}
                  borderStyle="round"
                  borderColor={focus === 'detail' ? 'cyan' : 'gray'}
                  overflow="hidden"
                  flexDirection="column"
                >
                  <Box flexDirection="column" flexShrink={0}>
                    {detailPane()}
                  </Box>
                </Box>
              </Box>
              <Hints step={hintStep} indent=" " />
              {Array.from({ length: hintRowsMax - hintRows }, (_, i) => (
                <Text key={`pad-${i}`}> </Text>
              ))}
            </>
          ) : (
            <Box flexDirection="column" flexShrink={0}>{screen()}</Box>
          )}
          <StatusBar step={step} picked={picked} result={result} focus={showSplit ? focus : undefined} notice={notice} columns={columns} />
        </>
      ) : (
        <>{screen()}</>
      )}
    </Box>
  );
}

function runNew(args: string[]) {
  const flags = parseFlags(args);
  if (flags.error) {
    process.stderr.write(`htui new: ${flags.error}\n`);
    process.exitCode = 1;
    return;
  }
  if (!process.stdin.isTTY) {
    process.stderr.write('htui: needs an interactive terminal (TTY).\n');
    process.exitCode = 1;
    return;
  }
  if (!httpyacOnPath()) {
    process.stderr.write(`htui: ${HTTPYAC_INSTALL_HINT}\n`);
    process.exitCode = 1;
    return;
  }
  render(<App initialNew into={flags.into} />);
}

function runTui(initialFile?: string) {
  if (!process.stdin.isTTY) {
    process.stderr.write(
      'htui: needs an interactive terminal (TTY). For scripts/agents use `htui import|list|remove`, or `httpyac send` directly.\n',
    );
    process.exitCode = 1;
    return;
  }
  // Fail here, not after the user has picked a request.
  if (!httpyacOnPath()) {
    process.stderr.write(`htui: ${HTTPYAC_INSTALL_HINT}\n`);
    process.exitCode = 1;
    return;
  }
  render(<App initialFile={initialFile} />);
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'import':
    process.exitCode = await importCommand(args);
    break;
  case 'list':
    process.exitCode = await listCommand(args);
    break;
  case 'remove':
    process.exitCode = await removeCommand(args);
    break;
  case 'send':
    process.exitCode = await sendCommand(args);
    break;
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  case 'version':
  case '--version':
  case '-V':
    printVersion();
    break;
  case 'new':
    runNew(args);
    break;
  default:
    // bare `htui` or `htui <file.http>`
    runTui(command);
}
