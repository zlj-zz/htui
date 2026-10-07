import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { regionText, toJson, type RequestModel } from '../request';

/**
 * The step between picking a request and sending it: show what will actually
 * go out, and let the user tweak it for this send only. The default view and
 * the `$EDITOR` buffer are the request in `.http` syntax — a body stays raw
 * text, so there are no JSON escapes to hand-manage. `J` shows a JSON view.
 * Nothing is written back to the `.http` file.
 */
export function RequestPreview({
  model,
  edited,
  error,
  onSend,
  onEdit,
  onBack,
  onQuit,
}: {
  model: RequestModel;
  edited: boolean;
  error: string;
  onSend: () => void;
  onEdit: () => void;
  onBack: () => void;
  onQuit: () => void;
}) {
  const [asJson, setAsJson] = useState(false);

  useInput((input, key) => {
    if (key.return) onSend();
    else if (key.ctrl && input === 'e') onEdit();
    else if (input.toLowerCase() === 'j') setAsJson((v) => !v);
    else if (key.escape) onBack();
    else if (input === 'q') onQuit();
  });

  const lines = (asJson ? toJson(model) : regionText(model)).replace(/\n$/, '').split('\n');
  const rows = Math.max(1, (process.stdout.rows ?? 24) - 6);
  const shown = lines.slice(0, rows);

  return (
    <Box flexDirection="column">
      <Text bold>
        Request{edited ? ' · edited (this send only)' : ''} {asJson ? '· json' : ''}
      </Text>
      {shown.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
      {lines.length > shown.length ? (
        <Text dimColor>… {lines.length - shown.length} more lines — Ctrl-E to see it all</Text>
      ) : null}
      {error ? <Text color="red">✗ {error}</Text> : null}
      <Text dimColor>[Enter] send   [Ctrl-E] edit   [J] json view   [Esc] back   [q] quit</Text>
    </Box>
  );
}
