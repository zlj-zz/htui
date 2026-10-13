#!/usr/bin/env node
import { Box, Text, render, useApp, useInput } from 'ink';
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
import { chordOf, resolveKey, type Action, type Step } from './keys';
import { NewRequestForm } from './ui/NewRequestForm';
import { Hints } from './ui/Hints';
import { SearchableList } from './ui/SearchableList';
import { EnvForm } from './ui/EnvForm';
import { ImportForm } from './ui/ImportForm';
import { clipBody, floatToTop } from './rows';
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
const reqHint = (r: HttpRequest) => (r.name !== 'default' ? r.name : undefined);
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
}

function App({ initialFile, initialNew, into }: { initialFile?: string; initialNew?: boolean; into?: string }) {
  const { exit, suspendTerminal } = useApp();
  const [step, setStep] = useState<Step>(initialNew ? 'new' : 'file');
  const [files, setFiles] = useState<ScannedFile[] | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [requests, setRequests] = useState<HttpRequest[] | null>(null);
  const [workspace, setWorkspace] = useState<IndexedRequest[] | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
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
  const bodyView = useMemo(() => clipBody(bodyMatches.join('\n')), [bodyMatches]);
  const headersView = useMemo(
    () => (result?.response?.headers ? clipBody(JSON.stringify(result.response.headers, null, 2)) : ''),
    [result],
  );
  const [history, setHistory] = useState<HistoryEntry[]>([]);
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
  const requestItems = useMemo(
    () =>
      requests
        ? floatToTop(requests, (r) => recentRun.get(`${r.method} ${r.url} ${r.name}`) ?? Number.MAX_SAFE_INTEGER)
        : requests,
    [requests, recentRun],
  );
  const requestGroup = (r: HttpRequest) =>
    recentRun.has(`${r.method} ${r.url} ${r.name}`) ? 'recent' : undefined;
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
    readFile(file, 'utf8')
      .then((content) => {
        const reqs = parseRequests(content);
        if (reqs.length === 0) {
          fail(`No selectable requests in ${relOf(file)}`);
          return;
        }
        setRequests(reqs);
        void restoreEnvSelection(file);
      })
      .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
  }, [file, refresh]);

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
        return;
      }
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  async function edit(filePath: string, line: number) {
    try {
      // Hand the terminal to the editor, then repaint the TUI.
      await suspendTerminal(() => openEditor(filePath, line));
    } catch (err: unknown) {
      fail(err instanceof Error ? err.message : String(err));
      return;
    }
    setRefresh((n) => n + 1); // re-read the file after editing
    showNotice(`reloaded ${path.basename(filePath)}`, 'info');
  }

  async function editEnv(envPath: string) {
    try {
      await suspendTerminal(() => openEditor(envPath, 1));
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
    if (action === 'preview' && r && file) void openPreview(file, r, 'request');
    // `r` runs it right away — the preview sits on Enter, not on the fast path.
    else if (action === 'run' && r && file) void send({ file, req: r }, 'request');
    else if (action === 'run' && r && file) void send({ file, req: r }, 'request');
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
    { isActive: (step === 'result' || step === 'error') && !bodySearching },
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
    { isActive: step === 'result' && bodySearching },
  );

  function cancelSend() {
    abortRef.current?.abort();
  }

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

  if (step === 'preview') {
    if (!preview) return <Spinner label="Reading request…" />;
    return (
      <RequestPreview
        model={preview.model}
        envHeaders={preview.envHeaders}
        edited={preview.edited}
        error={preview.error}
        notice={notice}
        onModel={(model) => setPreview((p) => (p ? { ...p, model, edited: true, error: '' } : p))}
        onSave={() => void savePreview()}
        onAction={(action) => {
          if (action === 'send')
            void send(
              { file: preview.file, req: preview.req },
              'preview',
              preview.edited ? { model: preview.model } : {},
            );
          else if (action === 'edit-preview') void editPreview();
          else if (action === 'copy-body') void copyPreviewBody();
          else if (action === 'copy-curl') void copyPreviewCurl();
          else if (action === 'back') setStep(previewReturn);
          else appAction(action);
        }}
      />
    );
  }

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

  if (step === 'request') {
    if (!file) return <Text color="red">No file selected.</Text>;
    if (!requests) return <Spinner label="Parsing requests…" />;
    return (
      <SearchableList
        step="request"
        header={`${relOf(file)}  ·  env:${activeEnv}`}
        placeholder="filter requests…"
        items={requestItems ?? []}
        keyOf={reqKey}
        labelOf={reqLabel}
        hintOf={reqHint}
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

  if (step === 'sending') {
    return (
      <Box flexDirection="column">
        <Spinner label={`Sending ${picked?.req.method} ${picked?.req.url} …`} />
        <Hints step="sending" />
      </Box>
    );
  }

  const response = result?.response;
  // A response without a status code means the request never completed.
  const completed = hasResponse(response);
  const tests = result?.testResults ?? [];

  return (
    <Box flexDirection="column">
      <Text color={completed ? statusColor(response?.statusCode) : 'red'}>
        {picked?.req.method} {picked?.req.url} →{' '}
        {completed ? `${response?.statusCode} ${response?.statusMessage ?? ''}` : 'failed'}
        {result?.duration != null ? `  ${Math.round(result.duration)}ms` : ''}
      </Text>
      {picked ? <Text dimColor>{relOf(picked.file)}</Text> : null}

      {completed ? (
        <>
          {response?.headers ? (
            showHeaders ? (
              <Text dimColor>{headersView}</Text>
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
          <Box marginTop={1}>
            <Text>{bodyView}</Text>
          </Box>
        </>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {result?.stderr ? <Text color="red">{clipBody(result.stderr)}</Text> : null}
          {tests.length === 0 ? (
            result?.stderr ? null : <Text color="red">no response</Text>
          ) : (
            tests.map((t, i) => <TestLine key={i} test={t} />)
          )}
        </Box>
      )}

      {completed && tests.length ? (
        <Box marginTop={1} flexDirection="column">
          {tests.map((t, i) => (
            <TestLine key={i} test={t} />
          ))}
        </Box>
      ) : null}

      <Text color={notice?.kind === 'warn' ? 'yellow' : 'cyan'}>{notice?.text ?? ' '}</Text>
      <Box marginTop={1} flexDirection="column">
        <Hints step="result" />
      </Box>
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
