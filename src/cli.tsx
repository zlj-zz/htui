#!/usr/bin/env node
import { Box, Text, render, useApp, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { parseRequests, type HttpRequest } from './parse';
import { hasResponse, isOk, testIcon, type HttpyacRequestResult, type TestResult } from './result';
import { runChain, type ChainEntry } from './chain';
import { httpyacOnPath, HTTPYAC_INSTALL_HINT, isAbort, runRequest } from './run';
import { buildWorkspace, listFiles, type IndexedRequest, type ScannedFile } from './workspace';
import { collectEnvNames } from './store';
import { modelSlice, parseRegionText, regionText, requestModel, type RequestModel } from './request';
import { openEditor } from './editor';
import { copyToTerminal, toCurl } from './share';
import { importCommand, listCommand, printHelp, printVersion, removeCommand, sendCommand } from './commands';
import { chordOf, resolveKey, type Action, type Step } from './keys';
import { Hints } from './ui/Hints';
import { SearchableList } from './ui/SearchableList';
import { ImportForm } from './ui/ImportForm';
import { clipBody } from './rows';
import { Help } from './ui/Help';
import { HeaderForm } from './ui/HeaderForm';
import { RequestPreview } from './ui/RequestPreview';

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

async function writeFileAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
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

function App({ initialFile }: { initialFile?: string }) {
  const { exit, suspendTerminal } = useApp();
  const [step, setStep] = useState<Step>('file');
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
  const [headerCtx, setHeaderCtx] = useState<{ file: string; content: string; req: HttpRequest } | null>(null);
  const [headerReturn, setHeaderReturn] = useState<Step>('request');
  const [preview, setPreview] = useState<{
    file: string;
    req: HttpRequest;
    model: RequestModel;
    edited: boolean;
    error: string;
  } | null>(null);
  const [previewReturn, setPreviewReturn] = useState<Step>('request');
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<HttpyacRequestResult | null>(null);
  const [prereqs, setPrereqs] = useState<ChainEntry[]>([]);
  const [showHeaders, setShowHeaders] = useState(false);
  const [notice, setNotice] = useState('');
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
  const [historyReturn, setHistoryReturn] = useState<Step>('result');
  const [helpReturn, setHelpReturn] = useState<Step>('file');
  const [error, setError] = useState('');

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
        if (initialFile) {
          setFile(path.resolve(initialFile));
          setStep('request');
        } else if (found.length === 1) {
          setFile(found[0].file);
          setStep('request');
        }
      })
      .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
  }, [initialFile, refresh]);

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
  }

  async function send(target: Picked, from: From, opts?: { chain?: boolean; model?: RequestModel }) {
    setPicked(target);
    setOrigin(from);
    setError('');
    setPrereqs([]);
    setShowHeaders(false);
    setNotice('');
    setBodyQuery('');
    setBodySearching(false);
    setStep('sending');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let res: HttpyacRequestResult | null;
      if (opts?.model) {
        // Edited in the preview: run the preamble + the rebuilt region, so any
        // `{{login.response…}}` dependency still resolves.
        const content = await readFile(target.file, 'utf8');
        const outcome = await runChain({
          file: target.file,
          content,
          target: target.req,
          env: activeEnv,
          slice: modelSlice(content, target.req, opts.model),
          signal: controller.signal,
        });
        setPrereqs(outcome.prerequisites);
        res = outcome.target ?? null;
      } else if (opts?.chain) {
        // A dependent request only works when its prerequisites run in the same
        // httpyac invocation, so run the file slice up to this region.
        const content = await readFile(target.file, 'utf8');
        const outcome = await runChain({
          file: target.file,
          content,
          target: target.req,
          env: activeEnv,
          signal: controller.signal,
        });
        setPrereqs(outcome.prerequisites);
        res = outcome.target ?? null;
      } else {
        res = await runRequest(target.file, target.req, activeEnv, controller.signal);
      }
      setResult(res);
      record(target, res);
      setStep('result');
    } catch (err: unknown) {
      if (isAbort(err)) {
        setNotice('cancelled');
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
  }

  async function editEnv(envPath: string) {
    try {
      await suspendTerminal(() => openEditor(envPath, 1));
    } catch (err: unknown) {
      fail(err instanceof Error ? err.message : String(err));
      return;
    }
    setRefresh((n) => n + 1);
  }

  async function saveBody(result: HttpyacRequestResult) {
    const target = path.join(os.tmpdir(), `htui-body-${Date.now()}.json`);
    try {
      await writeFile(target, rawBody(result), { encoding: 'utf8', mode: 0o600 });
      setNotice(`saved ${target}`);
    } catch (err: unknown) {
      setNotice(`save failed: ${err instanceof Error ? err.message : String(err)}`);
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
      setPreview({ file: filePath, req, model: requestModel(content, req), edited: false, error: '' });
      setPreviewReturn(from);
      setStep('preview');
    } catch (err: unknown) {
      fail(err instanceof Error ? err.message : String(err));
    }
  }

  async function editPreview() {
    if (!preview) return;
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
    else if (action === 'chain' && r && file) void send({ file, req: r }, 'request', { chain: true });
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
    if (action === 'select-env' && name) {
      setActiveEnv(name);
      setStep(envReturn);
    } else if (action === 'edit') void editEnv(envFile);
    else if (action === 'back') setStep(envReturn);
  }

  function resultAction(action: Action) {
    if (appAction(action)) return;
    if (action === 'back' && file) {
      setResult(null);
      setError('');
      setStep(resultReturn());
    } else if (action === 'run' && picked) void send(picked, origin);
    else if (action === 'chain' && picked) void send(picked, origin, { chain: true });
    else if (action === 'edit' && picked) void edit(picked.file, picked.req.line);
    else if (action === 'vars' && picked) {
      void editEnv(path.join(path.dirname(picked.file), 'http-client.env.json'));
    } else if (action === 'history') {
      setHistoryReturn('result');
      setStep('history');
    } else if (action === 'fold-headers') setShowHeaders((v) => !v);
    else if (action === 'search-body') setBodySearching(true);
    else if (action === 'copy-body' && result) {
      const r = copyToTerminal(rawBody(result));
      setNotice(r.ok ? `copied ${r.bytes} bytes` : 'body too large for the clipboard — press w to save it');
    } else if (action === 'copy-curl' && result && picked) {
      const sent = result.response?.request;
      const curl = toCurl({
        method: sent?.method ?? picked.req.method,
        url: sent?.url ?? picked.req.url,
        headers: sent?.headers,
        body: typeof sent?.body === 'string' ? sent.body : undefined,
      });
      const r = copyToTerminal(curl);
      setNotice(r.ok ? 'copied curl (may contain credentials)' : 'command too large for the clipboard');
    } else if (action === 'save' && result) void saveBody(result);
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

  if (step === 'headers') {
    if (!headerCtx) return <Spinner label="Reading request…" />;
    return (
      <HeaderForm
        content={headerCtx.content}
        req={headerCtx.req}
        onSave={async (next) => {
          await writeFileAtomic(headerCtx.file, next);
          setHeaderCtx({ ...headerCtx, content: next });
          setRefresh((n) => n + 1);
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
        edited={preview.edited}
        error={preview.error}
        onAction={(action) => {
          if (action === 'send')
            void send(
              { file: preview.file, req: preview.req },
              'preview',
              preview.edited ? { model: preview.model } : {},
            );
          else if (action === 'edit-preview') void editPreview();
          else if (action === 'back') setStep(previewReturn);
          else appAction(action);
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
        onAction={historyAction}
      />
    );
  }

  if (step === 'env') {
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
        onAction={envAction}
      />
    );
  }

  if (step === 'file') {
    if (!files) return <Spinner label="Scanning for .http / .rest files…" />;
    return (
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
        onAction={fileAction}
      />
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
        items={requests}
        keyOf={reqKey}
        labelOf={reqLabel}
        hintOf={reqHint}
        noun="requests"
        leadOf={reqLead}
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

      {prereqs.length ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>
            chain · {prereqs.length} prerequisite{prereqs.length > 1 ? 's' : ''}
          </Text>
          {prereqs.map((p, i) => (
            <Text key={i} color={p.ok ? 'green' : 'red'}>
              {p.ok ? '✓' : '✗'} {p.name}
              {p.statusCode != null ? ` ${p.statusCode}` : ''}
              {p.message ? ` — ${p.message}` : ''}
            </Text>
          ))}
        </Box>
      ) : null}

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

      {notice ? <Text color="cyan">{notice}</Text> : null}
      <Box marginTop={1} flexDirection="column">
        <Hints step="result" />
      </Box>
    </Box>
  );
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
  default:
    // bare `htui` or `htui <file.http>`
    runTui(command);
}
