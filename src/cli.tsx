#!/usr/bin/env node
import { useEffect, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { Select, Spinner } from '@inkjs/ui';
import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { parseRequests, type HttpRequest } from './parse';

const execFileAsync = promisify(execFile);

const HTTP_FILE = /\.(http|rest)$/i;
const SKIP_DIR = new Set(['node_modules', '.git', 'dist']);

/** Recursively find .http/.rest files (bounded depth, skips junk dirs). */
async function findHttpFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const e of entries) {
    if (SKIP_DIR.has(e.name) || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) found.push(...(await findHttpFiles(full, depth + 1)));
    else if (HTTP_FILE.test(e.name)) found.push(full);
  }
  return found;
}

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
  const args = ['send', insideCwd ? rel : path.basename(file), '--json', '--no-color'];
  if (req.name !== 'default') args.push('--name', req.name);
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

type Step = 'file' | 'request' | 'sending' | 'result' | 'error';

function App({ initialFile }: { initialFile?: string }) {
  const { exit } = useApp();
  const [files, setFiles] = useState<string[]>([]);
  const [step, setStep] = useState<Step>('file');
  const [file, setFile] = useState<string | null>(null);
  const [requests, setRequests] = useState<HttpRequest[]>([]);
  const [picked, setPicked] = useState<HttpRequest | null>(null);
  const [result, setResult] = useState<HttpyacRequestResult | null>(null);
  const [error, setError] = useState('');

  // pick a file
  useEffect(() => {
    if (initialFile) {
      setFile(path.resolve(initialFile));
      setStep('request');
      return;
    }
    findHttpFiles(process.cwd()).then((found) => {
      if (found.length === 0) {
        setError(`No .http / .rest files found under ${process.cwd()}`);
        setStep('error');
      } else if (found.length === 1) {
        setFile(found[0]);
        setStep('request');
      } else {
        setFiles(found);
      }
    });
  }, [initialFile]);

  // load requests when a file is chosen
  useEffect(() => {
    if (!file) return;
    readFile(file, 'utf8')
      .then((content) => {
        const reqs = parseRequests(content);
        setRequests(reqs);
        if (reqs.length === 0) {
          setError(`No selectable requests in ${path.relative(process.cwd(), file)}`);
          setStep('error');
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setStep('error');
      });
  }, [file]);

  async function send(req: HttpRequest) {
    if (!file) return;
    setPicked(req);
    setStep('sending');
    try {
      setResult(await runHttpyac(file, req));
      setStep('result');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('error');
    }
  }

  useInput((input) => {
    if (step === 'error' && input === 'q') exit();
    if (step !== 'result') return;
    if (input === 'q') exit();
    if (input === 'b') {
      setStep('request');
      setResult(null);
    }
    if (input === 'r' && picked) void send(picked);
  });

  if (step === 'error') {
    return (
      <Box flexDirection="column">
        <Text color="red">✗ {error}</Text>
        <Text dimColor>q to quit</Text>
      </Box>
    );
  }

  if (step === 'file') {
    return (
      <Box flexDirection="column">
        <Text bold>Select an .http file</Text>
        <Select
          options={files.map((f) => ({ label: path.relative(process.cwd(), f), value: f }))}
          onChange={(value) => {
            setFile(value);
            setStep('request');
          }}
        />
      </Box>
    );
  }

  if (step === 'request') {
    return (
      <Box flexDirection="column">
        <Text bold>{path.relative(process.cwd(), file ?? '')}</Text>
        <Select
          options={requests.map((r, i) => ({
            label: `${r.method} ${r.url}${r.name !== 'default' ? `  · ${r.name}` : ''}`,
            value: String(i),
          }))}
          onChange={(value) => void send(requests[Number(value)])}
        />
      </Box>
    );
  }

  if (step === 'sending') {
    return <Spinner label={`Sending ${picked?.method} ${picked?.url} …`} />;
  }

  return (
    <Box flexDirection="column">
      <Text color={statusColor(result?.response?.statusCode)}>
        {picked?.method} {picked?.url} → {result?.response?.statusCode ?? '?'}{' '}
        {result?.response?.statusMessage ?? ''}
        {result?.duration != null ? `  ${Math.round(result.duration)}ms` : ''}
      </Text>
      {result?.response?.headers ? (
        <Text dimColor>{JSON.stringify(result.response.headers, null, 2)}</Text>
      ) : null}
      <Box marginTop={1}>
        <Text>{bodyText(result?.response?.body)}</Text>
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

render(<App initialFile={process.argv[2]} />);
