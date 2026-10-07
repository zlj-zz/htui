import { Box, Text, useInput } from 'ink';
import { chordOf, resolveKey, type Action } from '../keys';
import { Hints } from './Hints';
import { regionText, type RequestModel } from '../request';

/**
 * The step between picking a request and sending it: show what will actually
 * go out, and let the user tweak it for this send only (`Ctrl-E`). The view and
 * the `$EDITOR` buffer are the request in `.http` syntax — a body stays raw
 * text, so there are no JSON escapes to hand-manage. Nothing is written back to
 * the `.http` file.
 */
export function RequestPreview({
  model,
  edited,
  error,
  onAction,
}: {
  model: RequestModel;
  edited: boolean;
  error: string;
  onAction: (action: Action) => void;
}) {
  useInput((input, key) => {
    const action = resolveKey('preview', chordOf(input, key));
    if (action) onAction(action);
  });

  const lines = regionText(model).replace(/\n$/, '').split('\n');
  const rows = Math.max(1, (process.stdout.rows ?? 24) - 6);
  const shown = lines.slice(0, rows);

  return (
    <Box flexDirection="column">
      <Text bold>Request{edited ? ' · edited (this send only)' : ''}</Text>
      {shown.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
      {lines.length > shown.length ? (
        <Text dimColor>… {lines.length - shown.length} more lines — Ctrl-E to see it all</Text>
      ) : null}
      {error ? <Text color="red">✗ {error}</Text> : null}
      <Hints step="preview" />
    </Box>
  );
}
