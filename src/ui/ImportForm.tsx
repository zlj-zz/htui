import { TextInput } from '@inkjs/ui';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { importOpenApi, inspectSpec, type ImportResult } from '../import-openapi';
import { chordOf, resolveKey, type Action } from '../keys';

type Phase = 'spec' | 'name' | 'confirm';

/**
 * Runtime OpenAPI import. Reuses the same `importOpenApi` core as the CLI —
 * this component only adds the form.
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
  const [specPath, setSpecPath] = useState('');
  const [defaultName, setDefaultName] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  async function chooseSpec(input: string) {
    const value = input.trim();
    if (!value) return;
    try {
      const info = await inspectSpec(value);
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
      onDone(await importOpenApi({ specPath, name: collectionName, local, force }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!force && /already exists/.test(message)) setPhase('confirm');
      else setError(message);
    }
  }

  // Esc cancels from any phase. `o` overwrites in the confirm phase. The map
  // is only consulted outside a text field, so typing "q" never quits.
  useInput((input, key) => {
    const action = resolveKey('import', chordOf(input, key));
    if (!action) return;
    if (action === 'back') onCancel();
    else if (phase !== 'confirm') return; // a text field owns the keyboard
    else if (action === 'overwrite') void runImport(name, true);
    else onAction(action); // help / quit
  });

  if (phase === 'spec') {
    return (
      <Box flexDirection="column">
        <Text bold>Import OpenAPI (JSON)</Text>
        <Text dimColor>path to spec file · Esc to cancel</Text>
        <TextInput placeholder="/path/to/openapi.json" onSubmit={(value) => void chooseSpec(value)} />
        {error ? <Text color="red">✗ {error}</Text> : null}
      </Box>
    );
  }

  if (phase === 'name') {
    return (
      <Box flexDirection="column">
        <Text bold>Import OpenAPI (JSON)</Text>
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
      <Text bold>Import OpenAPI (JSON)</Text>
      <Text color="yellow">collection &quot;{name}&quot; already exists.</Text>
      <Text>[o] overwrite · [Esc] cancel</Text>
      {error ? <Text color="red">✗ {error}</Text> : null}
    </Box>
  );
}
