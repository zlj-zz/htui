#!/usr/bin/env node
import { Box, Text, render, useApp, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import { useEffect, useState } from 'react';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { parseRequests, type HttpRequest } from './parse';
import { buildWorkspace, findHttpFiles, type IndexedRequest } from './workspace';
import { SearchableList } from './ui/SearchableList';

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
  testResults?: Array<{ message?: string; status?: boolean }>;
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

type Step = 'file' | 'request' | 'search' | 'sending' | 'result' | 'error';
type From = 'request' | 'search';
interface Picked {
  file: string;
  req: HttpRequest;
}

function App({ initialFile }: { initialFile?: string }) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>('file');
  const [files, setFiles] = useState<string[] | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [requests, setRequests] = useState<HttpRequest[] | null>(null);
  const [workspace, setWorkspace] = useState<IndexedRequest[] | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [origin, setOrigin] = useState<From>('request');
  const [searchFrom, setSearchFrom] = useState<'file' | 'request'>('request');
  const [result, setResult] = useState<HttpyacRequestResult | null>(null);
  const [error, setError] = useState('');

  function fail(message: string) {
    setError(message);
    setStep('error');
  }

  // initial scan
  useEffect(() => {
    findHttpFiles(process.cwd())
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
          setFile(found[0]);
          setStep('request');
        }
      })
      .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
  }, [initialFile]);

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

  if (step === 'file') {
    if (!files) return <Spinner label="Scanning for .http / .rest files…" />;
    return (
      <SearchableList
        header={`Select a file — ${process.cwd()}`}
        placeholder="filter files…"
        items={files}
        keyOf={(f) => relOf(f)}
        labelOf={(f) => path.basename(f)}
        hintOf={(f) => dirOf(relOf(f))}
        groupOf={(f) => dirOf(relOf(f))}
        onSelect={(f) => {
          setFile(f);
          setStep('request');
        }}
        onSearchKey={() => void openSearch('file')}
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
  return (
    <Box flexDirection="column">
      <Text color={statusColor(response?.statusCode)}>
        {picked?.req.method} {picked?.req.url} → {response?.statusCode ?? '?'} {response?.statusMessage ?? ''}
        {result?.duration != null ? `  ${Math.round(result.duration)}ms` : ''}
      </Text>
      {picked ? <Text dimColor>{relOf(picked.file)}</Text> : null}
      {response?.headers ? (
        <Text dimColor>{clipBody(JSON.stringify(response.headers, null, 2))}</Text>
      ) : null}
      <Box marginTop={1}>
        <Text>{clipBody(bodyText(response?.body))}</Text>
      </Box>
      {result?.testResults?.length ? (
        <Box marginTop={1} flexDirection="column">
          {result.testResults.map((t, i) => (
            <Text key={i} color={t.status ? 'green' : 'red'}>
              {t.status ? '✓' : '✗'} {t.message ?? ''}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>[r] rerun [b] back [q] quit</Text>
      </Box>
    </Box>
  );
}

if (!process.stdin.isTTY) {
  process.stderr.write(
    'htui: needs an interactive terminal (TTY). Non-interactive: `httpyac send <file> --json`.\n',
  );
  process.exit(1);
}

render(<App initialFile={process.argv[2]} />);
