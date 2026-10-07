import { TextInput } from '@inkjs/ui';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { importOpenApi, inspectSpec } from '../import-openapi';
import { importProto, inspectProto } from '../import-proto';
import { chordOf, resolveKey, type Action } from '../keys';
import type { ImportResult } from '../write-collection';

type Phase = 'spec' | 'name' | 'confirm';
type Kind = 'openapi' | 'proto';

/**
 * Runtime import form, routed by file extension: `.proto` → gRPC collection,
 * anything else → OpenAPI. Both go through the same core as the CLI.
 */
export function ImportForm({
  local,
  onDone,
  onCancel,
  onAction,
}: {
  local?: boolean;
  onDone: (result: ImportResult) => void;
  onCancel: () => void;
  /** Actions this form does not own (help / quit) go to the app. */
  onAction: (action: Action) => void;
}) {
  const [phase, setPhase] = useState<Phase>('spec');
  const [kind, setKind] = useState<Kind>('openapi');
  const [specPath, setSpecPath] = useState('');
  const [defaultName, setDefaultName] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  async function chooseSpec(input: string) {
    const value = input.trim();
    if (!value) return;
    const proto = /\.proto$/i.test(value);
    try {
      const info = proto ? await inspectProto(value) : await inspectSpec(value);
      setKind(proto ? 'proto' : 'openapi');
      setSpecPath(value);
      setDefaultName(info.name);
      setError('');
      setPhase('name');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function runImport(collectionName: string, force: boolean) {
    setName(collectionName);
    try {
      const result =
        kind === 'proto'
          ? await importProto({ protoPaths: [specPath], name: collectionName, local, force })
          : await importOpenApi({ specPath, name: collectionName, local, force });
      onDone(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!force && /already exists/.test(message)) setPhase('confirm');
      else setError(message);
    }
  }

  // Esc cancels from any phase. The map is only consulted outside a text field,
  // so typing "q" never quits.
  useInput((input, key) => {
    const action = resolveKey('import', chordOf(input, key));
    if (!action) return;
    if (action === 'back') onCancel();
    else if (phase !== 'confirm') return; // a text field owns the keyboard
    else if (action === 'overwrite') void runImport(name, true);
    else onAction(action); // help / quit
  });

  const title = kind === 'proto' ? 'Import gRPC (proto)' : 'Import OpenAPI (JSON)';

  if (phase === 'spec') {
    return (
      <Box flexDirection="column">
        <Text bold>{title}</Text>
        <Text dimColor>path to spec file · Esc to cancel</Text>
        <TextInput placeholder="/path/to/api.json or api.proto" onSubmit={(value) => void chooseSpec(value)} />
        {error ? <Text color="red">✗ {error}</Text> : null}
      </Box>
    );
  }

  if (phase === 'name') {
    return (
      <Box flexDirection="column">
        <Text bold>{title}</Text>
        <Text dimColor>{specPath}</Text>
        <Text>collection name</Text>
        <TextInput
          defaultValue={defaultName}
          onSubmit={(value) => void runImport(value.trim() || defaultName, false)}
        />
        {error ? <Text color="red">✗ {error}</Text> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text color="yellow">collection &quot;{name}&quot; already exists.</Text>
      <Text>[o] overwrite · [Esc] cancel</Text>
      {error ? <Text color="red">✗ {error}</Text> : null}
    </Box>
  );
}
