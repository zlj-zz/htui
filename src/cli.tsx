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
import { runRequest } from './run';
import { buildWorkspace, listFiles, type IndexedRequest, type ScannedFile } from './workspace';
import { collectEnvNames } from './store';
import { openEditor } from './editor';
import { copyToTerminal, toCurl } from './share';
import { importCommand, listCommand, printHelp, printVersion, removeCommand, sendCommand } from './commands';
import { SearchableList } from './ui/SearchableList';
import { ImportForm } from './ui/ImportForm';
import { Help } from './ui/Help';
import { HeaderForm } from './ui/HeaderForm';

const MAX_BODY_LINES = 200;

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

/** Cap what we render — an unbounded body is the biggest screen-flood source. */
function clipBody(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= MAX_BODY_LINES) return text;
  return `${lines.slice(0, MAX_BODY_LINES).join('\n')}\n… (+${lines.length - MAX_BODY_LINES} more lines)`;
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
const reqLabel = (r: HttpRequest) => `${r.method} ${r.url}`;
const reqHint = (r: HttpRequest) => (r.name !== 'default' ? r.name : undefined);
const searchKey = (r: IndexedRequest) => `${r.method} ${r.url} ${r.name} ${r.relPath}`;
const searchHint = (r: IndexedRequest) => `${r.relPath}${r.name !== 'default' ? ` · ${r.name}` : ''}`;
const historyKey = (e: HistoryEntry) => `${e.method} ${e.url} ${e.name}`;
const historyLabel = (e: HistoryEntry) => `${e.method} ${e.url}`;
const historyHint = (e: HistoryEntry) => `${e.ok ? '✓' : '✗'} ${e.status ?? '?'}  ${e.name}`;
const envLabel = (n: string) => n;

type Step = 'file' | 'request' | 'search' | 'import' | 'env' | 'headers' | 'sending' | 'result' | 'history' | 'help' | 'error';
type From = 'request' | 'search';
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
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<HttpyacRequestResult | null>(null);
  const [prereqs, setPrereqs] = useState<ChainEntry[]>([]);
  const [showHeaders, setShowHeaders] = useState(false);
  const [notice, setNotice] = useState('');

  // Render-side memo: parsing/pretty-printing a body on every keypress is wasteful.
  const bodyView = useMemo(() => clipBody(bodyText(result?.response?.body)), [result]);
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

  async function send(target: Picked, from: From, opts?: { chain?: boolean }) {
    setPicked(target);
    setOrigin(from);
    setError('');
    setPrereqs([]);
    setShowHeaders(false);
    setNotice('');
    setStep('sending');
    try {
      let res: HttpyacRequestResult | null;
      if (opts?.chain) {
        // A dependent request only works when its prerequisites run in the same
        // httpyac invocation, so run the file slice up to this region.
        const content = await readFile(target.file, 'utf8');
        const outcome = await runChain({
          file: target.file,
          content,
          target: target.req,
          env: activeEnv,
        });
        setPrereqs(outcome.prerequisites);
        res = outcome.target ?? null;
      } else {
        res = await runRequest(target.file, target.req, activeEnv);
      }
      setResult(res);
      record(target, res);
      setStep('result');
    } catch (err: unknown) {
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
      if (input === 'q') exit();
      if (input === 'b' && file) {
        setResult(null);
        setError('');
        setStep(origin === 'search' ? 'search' : 'request');
      }
      if (input === 'r' && picked) void send(picked, origin);
      if (input === 'R' && picked) void send(picked, origin, { chain: true });
      if (input === 'e' && step === 'result' && picked) void edit(picked.file, picked.req.line);
      if (input === 'v' && step === 'result' && picked) {
        void editEnv(path.join(path.dirname(picked.file), 'http-client.env.json'));
      }
      if (input === 't' && step === 'result') {
        setHistoryReturn('result');
        setStep('history');
      }
      if (input === 'h' && step === 'result') setShowHeaders((v) => !v);
      if (input === 'y' && step === 'result' && result) {
        const r = copyToTerminal(rawBody(result));
        setNotice(r.ok ? `copied ${r.bytes} bytes` : 'body too large for the clipboard — press w to save it');
      }
      if (input === 'Y' && step === 'result' && result && picked) {
        const sent = result.response?.request;
        const curl = toCurl({
          method: sent?.method ?? picked.req.method,
          url: sent?.url ?? picked.req.url,
          headers: sent?.headers,
          body: typeof sent?.body === 'string' ? sent.body : undefined,
        });
        const r = copyToTerminal(curl);
        setNotice(r.ok ? 'copied curl (may contain credentials)' : 'command too large for the clipboard');
      }
      if (input === 'w' && step === 'result' && result) void saveBody(result);
      if (input === '?') openHelp(step);
    },
    { isActive: step === 'result' || step === 'error' },
  );

  useInput(
    (input, key) => {
      if (input === '?' || key.escape) setStep(helpReturn);
    },
    { isActive: step === 'help' },
  );

  if (step === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ {error}</Text>
        <Text dimColor>
          {file ? '[b] back  ' : ''}
          {picked ? '[r] retry  [R] chain  ' : ''}
          [?] help  [q] quit
        </Text>
      </Box>
    );
  }

  if (step === 'import') {
    return (
      <ImportForm
        onCancel={() => setStep(importReturn)}
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
        onClose={() => setStep(headerReturn)}
      />
    );
  }

  if (step === 'help') return <Help />;

  if (step === 'history') {
    return (
      <SearchableList
        header={`History (${history.length})  ·  env:${activeEnv}`}
        onHelp={() => openHelp('history')}
        onQuit={exit}
        placeholder="filter history…"
        items={history}
        keyOf={historyKey}
        labelOf={historyLabel}
        hintOf={historyHint}
        onSelect={(e) => void send(e.picked, 'request')}
        onBack={() => setStep(historyReturn)}
      />
    );
  }

  if (step === 'env') {
    if (!envNames) return <Spinner label="Reading environments…" />;
    return (
      <SearchableList
        header={`Environment · ${relOf(envFile)}  (current: ${activeEnv})`}
        onHelp={() => openHelp('env')}
        onQuit={exit}
        placeholder="filter environments…"
        items={envNames}
        keyOf={envLabel}
        labelOf={envLabel}
        onSelect={(n) => {
          setActiveEnv(n);
          setStep(envReturn);
        }}
        onCommand={(key) => {
          if (key === 'e') void editEnv(envFile);
        }}
        controls={[{ key: 'e', label: 'edit file' }]}
        onBack={() => setStep(envReturn)}
      />
    );
  }

  if (step === 'file') {
    if (!files) return <Spinner label="Scanning for .http / .rest files…" />;
    return (
      <SearchableList
        header={`Select a file — ${process.cwd()}  ·  env:${activeEnv}`}
        onHelp={() => openHelp('file')}
        onQuit={exit}
        placeholder="filter files…"
        items={files}
        keyOf={fileKey}
        labelOf={fileLabel}
        hintOf={fileHint}
        groupOf={fileGroup}
        onSelect={(f) => {
          setFile(f.file);
          setStep('request');
        }}
        onCommand={(key, f) => {
          if (key === 'e' && f) void edit(f.file, 1);
          else if (key === 'i') openImport('file');
          else if (key === 's' && f) void openEnv(f.file, 'file');
        }}
        onControl={(key) => {
          if (key === 'f') void openSearch('file');
        }}
        controls={[
          { key: 'e', label: 'edit' },
          { key: 'i', label: 'import' },
          { key: 's', label: 'env' },
          { key: 'Ctrl-F', label: 'search' },
        ]}
      />
    );
  }

  if (step === 'request') {
    if (!file) return <Text color="red">No file selected.</Text>;
    if (!requests) return <Spinner label="Parsing requests…" />;
    return (
      <SearchableList
        header={`${relOf(file)}  ·  env:${activeEnv}`}
        onHelp={() => openHelp('request')}
        onQuit={exit}
        placeholder="filter requests…"
        items={requests}
        keyOf={reqKey}
        labelOf={reqLabel}
        hintOf={reqHint}
        onSelect={(r) => void send({ file, req: r }, 'request')}
        onBack={() => setStep('file')}
        onCommand={(key, r) => {
          if (key === 'e' && r) void edit(file, r.line);
          else if (key === 'h' && r) void openHeaders(file, r, 'request');
          else if (key === 'i') openImport('request');
          else if (key === 'r' && r) void send({ file, req: r }, 'request', { chain: true });
          else if (key === 's') void openEnv(file, 'request');
        }}
        onControl={(key) => {
          if (key === 'f') void openSearch('request');
        }}
        controls={[
          { key: 'e', label: 'edit' },
          { key: 'h', label: 'headers' },
          { key: 'i', label: 'import' },
          { key: 'r', label: 'chain' },
          { key: 's', label: 'env' },
          { key: 'Ctrl-F', label: 'search' },
        ]}
      />
    );
  }

  if (step === 'search') {
    if (!workspace) return <Spinner label="Indexing requests…" />;
    return (
      <SearchableList
        header={`Search all requests  ·  env:${activeEnv}`}
        onHelp={() => openHelp('search')}
        onQuit={exit}
        placeholder="search method / url / name / path…"
        items={workspace}
        keyOf={searchKey}
        labelOf={reqLabel}
        hintOf={searchHint}
        onSelect={(r) => void send({ file: r.file, req: r }, 'search')}
        onBack={() => setStep(searchFrom)}
      />
    );
  }

  if (step === 'sending') {
    return <Spinner label={`Sending ${picked?.req.method} ${picked?.req.url} …`} />;
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
      <Box marginTop={1}>
        <Text dimColor>[r] rerun [R] chain [e] edit [v] vars [t] history [y] copy [Y] curl [w] save [h] headers [?] help [b] back [q] quit</Text>
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
