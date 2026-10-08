import { TextInput } from '@inkjs/ui';
import { Box, Text, useInput } from 'ink';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { useEffect, useState } from 'react';
import { openEditor } from '../editor';
import { chordOf, resolveKey, type Action } from '../keys';
import { METHODS } from '../parse';
import { appendRegion, type RequestModel } from '../request';
import { slugify } from '../store';
import { writeAtomic } from '../write-collection';

type Phase = 'method' | 'url' | 'name' | 'body' | 'target';

const slugFromUrl = (url: string) => {
  const clean = url.replace(/[{}]/g, '').split('?')[0].replace(/\/+$/, '');
  return slugify(clean.split('/').pop() ?? '') || 'request';
};

/**
 * Interactive request creation: method → url → name → body (optional,
 * `Ctrl-E` in `$EDITOR` — bodies are multi-line, a text field is not) →
 * target file. Writes a standard region into a new or existing `.http` file;
 * headers can be added afterwards with `h`, and the request is immediately
 * previewable and runnable like any other region.
 */
export function NewRequestForm({
  into,
  onCancel,
  onAction,
  onDone,
}: {
  into?: string;
  onCancel: () => void;
  onAction: (action: Action) => void;
  /** Called with the target file and the new region's key after writing. */
  onDone: (file: string, key: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>('method');
  const [method, setMethod] = useState('');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [body, setBody] = useState('');
  const [target, setTarget] = useState(into ?? '');
  const [filter, setFilter] = useState('');
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState('');

  const list = METHODS.filter((m) => m.toLowerCase().includes(filter.toLowerCase()));
  useEffect(() => setCursor(0), [filter]);

  async function editBody() {
    const tmp = path.join(os.tmpdir(), `htui-new-body-${randomUUID()}.txt`);
    try {
      await writeFile(tmp, body, 'utf8');
      await openEditor(tmp, 1);
      setBody((await readFile(tmp, 'utf8')).replace(/\s+$/, ''));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async function save(targetFile: string) {
    const file = path.resolve(targetFile);
    const requestName = (name || slugFromUrl(url)).trim() || 'request';
    const model: RequestModel = { method, url, headers: [], body };
    try {
      let content = '';
      try {
        content = await readFile(file, 'utf8');
      } catch {
        // new file — start empty
      }
      await writeAtomic(file, appendRegion(content, model, requestName));
      onDone(file, `${method} ${url} ${requestName}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Esc cancels the whole form from any phase. Inside text fields the field
  // owns the keyboard (typing `q` must type `q`), so nothing else is consulted.
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (phase === 'method') {
      if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow) setCursor((c) => Math.min(list.length - 1, c + 1));
      else if (key.return) {
        const picked = list[cursor];
        if (picked) {
          setMethod(picked);
          setFilter('');
          setCursor(0);
          setPhase('url');
        }
      } else if (key.backspace || key.delete) setFilter((f) => f.slice(0, -1));
      else if (input) setFilter((f) => f + input.replace(/[\r\n\t]/g, ''));
      return;
    }
    if (phase === 'body') {
      if (key.ctrl && input === 'e') void editBody();
      else if (key.return) setPhase('target');
      else if (input === 'q') onAction('quit');
      else if (input === '?') onAction('help');
      return;
    }
    // url / name / target: a TextInput owns the keyboard
  });

  const title = `New request · ${phase}`;

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {phase === 'method' ? (
        <>
          <Text dimColor>pick a method · type to filter · Enter to select · Esc cancel</Text>
          {list.map((m, i) => (
            <Text key={m} color={i === cursor ? 'cyan' : undefined}>
              {i === cursor ? '❯ ' : '  '}
              {m}
            </Text>
          ))}
          {list.length === 0 ? <Text dimColor>{'  (no matches)'}</Text> : null}
        </>
      ) : null}
      {phase === 'url' ? (
        <>
          <Text color="cyan">{method}</Text>
          <TextInput
            placeholder="{{host}}/path — {{vars}} allowed"
            onSubmit={(value) => {
              const cleaned = value.trim();
              if (!cleaned) {
                setError('url is required');
                return;
              }
              setUrl(cleaned);
              setName(slugify(slugFromUrl(cleaned)));
              setError('');
              setPhase('name');
            }}
          />
        </>
      ) : null}
      {phase === 'name' ? (
        <>
          <Text dimColor>
            {method} {url}
          </Text>
          <Text># @name</Text>
          <TextInput
            defaultValue={name}
            onSubmit={(value) => {
              setName(value.trim() || name);
              setPhase('body');
            }}
          />
        </>
      ) : null}
      {phase === 'body' ? (
        <>
          <Text dimColor>
            {method} {url}
          </Text>
          <Text>{body ? 'body:' : 'body is empty (valid)'} — Ctrl-E to write it in $EDITOR</Text>
          {body ? <Text dimColor>{body}</Text> : null}
          <Text dimColor>Enter to continue · headers can be added later with `h`</Text>
        </>
      ) : null}
      {phase === 'target' ? (
        <>
          <Text dimColor>
            {method} {url} · #{name || slugFromUrl(url)}
          </Text>
          <Text>save to file (creates it, or appends if it exists)</Text>
          <TextInput
            defaultValue={target}
            onSubmit={(value) => {
              const cleaned = value.trim();
              if (!cleaned) {
                setError('target file is required');
                return;
              }
              void save(cleaned);
            }}
          />
        </>
      ) : null}
      {error ? <Text color="red">✗ {error}</Text> : null}
    </Box>
  );
}
