#!/usr/bin/env node
import { Box, Text, render, useApp, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import { useEffect, useState } from 'react';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { parseRequests, type HttpRequest } from './parse';
import { hasResponse, testIcon, type TestResult } from './result';
import { buildWorkspace, listFiles, type IndexedRequest, type ScannedFile } from './workspace';
import { importCommand, listCommand, printHelp, printVersion, removeCommand } from './commands';
import { SearchableList } from './ui/SearchableList';
import { ImportForm } from './ui/ImportForm';

const execFileAsync = promisify(execFile);
const MAX_BODY_LINES = 200;

interface HttpyacResponse {
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, unknown>;
  body?: unknown;
}

interface HttpyacRequestResult {
  name?: string;
  response?: HttpyacResponse;
  duration?: number;
  testResults?: TestResult[];
}

/** Delegate execution to httpyac and read its documented JSON contract. */
async function runHttpyac(file: string, req: HttpRequest): Promise<HttpyacRequestResult> {
  // httpyac rejects paths outside its cwd, so pass a relative path and, when
  // the file lives elsewhere, run from the file's own directory.
  const rel = path.relative(process.cwd(), file);
  const insideCwd = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  const args = ['send', insideCwd ? rel : path.basename(file), '--line', String(req.line), '--json', '--no-color'];
  if (process.env.HTUI_ENV) args.push('-e', process.env.HTUI_ENV);
  const options = {
    encoding: 'utf8' as const,
    maxBuffer: 32 * 1024 * 1024,
    cwd: insideCwd ? process.cwd() : path.dirname(file),
  };

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('httpyac', args, options));
  } catch (err: unknown) {
    // httpyac exits non-zero on failed tests but still prints the JSON result.
    const e = err as { stdout?: string; stderr?: string; message?: string };
    if (e.stdout?.trim()) stdout = e.stdout;
    else throw new Error(e.stderr || e.message || String(err));
  }

  const parsed = JSON.parse(stdout);
  const first = Array.isArray(parsed.requests) ? parsed.requests[0] : undefined;
  if (!first) throw new Error('httpyac returned no requests');
  return first;
}

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

const relOf = (file: string) => path.relative(process.cwd(), file);
const dirOf = (p: string) => {
  const d = path.dirname(p);
  return d === '.' ? './' : `${d}/`;
};

// Imported collections live outside the project, so label them distinctly.
const fileGroup = (f: ScannedFile) => `${f.source === 'collection' ? '~ imported  ' : ''}${dirOf(f.relPath)}`;
const fileHint = (f: ScannedFile) => `${f.source === 'collection' ? '~ ' : ''}${dirOf(f.relPath)}`;

type Step = 'file' | 'request' | 'search' | 'import' | 'sending' | 'result' | 'error';
type From = 'request' | 'search';
interface Picked {
  file: string;
  req: HttpRequest;
}

function App({ initialFile }: { initialFile?: string }) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('file');
  const [files, setFiles] = useState<ScannedFile[] | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [requests, setRequests] = useState<HttpRequest[] | null>(null);
  const [workspace, setWorkspace] = useState<IndexedRequest[] | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [origin, setOrigin] = useState<From>('request');
  const [searchFrom, setSearchFrom] = useState<'file' | 'request'>('request');
  const [importReturn, setImportReturn] = useState<'file' | 'request'>('file');
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<HttpyacRequestResult | null>(null);
  const [error, setError] = useState('');

  function fail(message: string) {
    setError(message);
    setStep('error');
  }

  // initial scan
  useEffect(() => {
    listFiles(process.cwd())
      .then((found) => {
        if (found.length === 0) {
          fail(`No .http / .rest files found under ${process.cwd()}`);
          return;
        }
        setFiles(found);
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
  }, [file]);

  async function send(target: Picked, from: From) {
    setPicked(target);
    setOrigin(from);
    setError('');
    setStep('sending');
    try {
      setResult(await runHttpyac(target.file, target.req));
      setStep('result');
    } catch (err: unknown) {
      fail(err instanceof Error ? err.message : String(err));
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

  useInput(
    (input) => {
      if (input === 'q') exit();
      if (input === 'b' && file) {
        setResult(null);
        setError('');
        setStep(origin === 'search' ? 'search' : 'request');
      }
      if (input === 'r' && step === 'result' && picked) void send(picked, origin);
    },
    { isActive: step === 'result' || step === 'error' },
  );

  if (step === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ {error}</Text>
        <Text dimColor>{file ? '[b] back  ' : ''}[q] quit</Text>
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

  if (step === 'file') {
    if (!files) return <Spinner label="Scanning for .http / .rest files…" />;
    return (
      <SearchableList
        header={`Select a file — ${process.cwd()}`}
        placeholder="filter files…"
        items={files}
        keyOf={(f) => `${f.source} ${f.relPath}`}
        labelOf={(f) => path.basename(f.file)}
        hintOf={fileHint}
        groupOf={fileGroup}
        onSelect={(f) => {
          setFile(f.file);
          setStep('request');
        }}
        onSearchKey={() => void openSearch('file')}
        onImportKey={() => openImport('file')}
      />
    );
  }

  if (step === 'request') {
    if (!file) return <Text color="red">No file selected.</Text>;
    if (!requests) return <Spinner label="Parsing requests…" />;
    return (
      <SearchableList
        header={relOf(file)}
        placeholder="filter requests…"
        items={requests}
        keyOf={(r) => `${r.method} ${r.url} ${r.name}`}
        labelOf={(r) => `${r.method} ${r.url}`}
        hintOf={(r) => (r.name !== 'default' ? r.name : undefined)}
        onSelect={(r) => void send({ file, req: r }, 'request')}
        onBack={() => setStep('file')}
        onSearchKey={() => void openSearch('request')}
        onImportKey={() => openImport('request')}
      />
    );
  }

  if (step === 'search') {
    if (!workspace) return <Spinner label="Indexing requests…" />;
    return (
      <SearchableList
        header="Search all requests"
        placeholder="search method / url / name / path…"
        items={workspace}
        keyOf={(r) => `${r.method} ${r.url} ${r.name} ${r.relPath}`}
        labelOf={(r) => `${r.method} ${r.url}`}
        hintOf={(r) => `${r.relPath}${r.name !== 'default' ? ` · ${r.name}` : ''}`}
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

      {completed ? (
        <>
          {response?.headers ? (
            <Text dimColor>{clipBody(JSON.stringify(response.headers, null, 2))}</Text>
          ) : null}
          <Box marginTop={1}>
            <Text>{clipBody(bodyText(response?.body))}</Text>
          </Box>
        </>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {tests.length === 0 ? (
            <Text color="red">no response</Text>
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

      <Box marginTop={1}>
        <Text dimColor>[r] rerun [b] back [q] quit</Text>
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
