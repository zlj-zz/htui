import { Box, Text } from 'ink';
import { screenHints, type Step } from '../keys';

/**
 * Generated from the same tables the screens dispatch on (src/keys.ts), so the
 * help cannot disagree with what is bound. Only the grouping and the legend at
 * the bottom are hand-written.
 */
const SCREENS: Array<{ step: Step; title: string }> = [
  { step: 'file', title: 'Files' },
  { step: 'request', title: 'Requests' },
  { step: 'search', title: 'Search' },
  { step: 'history', title: 'History' },
  { step: 'env', title: 'Environment' },
  { step: 'headers', title: 'Headers' },
  { step: 'preview', title: 'Preview' },
  { step: 'result', title: 'Result' },
  { step: 'error', title: 'Error' },
];

export function Help() {
  return (
    <Box flexDirection="column">
      <Text bold>htui · keys</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="cyan">Everywhere</Text>
        <Text dimColor>{'  ? help    Esc back    q quit    (inside a text field, letters are typed)'}</Text>
      </Box>
      {SCREENS.map(({ step, title }) => (
        <Box key={step} marginTop={1} flexDirection="column">
          <Text color="cyan">{title}</Text>
          <Text>{'  '}{screenHints(step).map((h) => `[${h.key}] ${h.label}`).join('  ')}</Text>
        </Box>
      ))}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>{'  lists also: ↑↓ move · / filter · wheel scroll'}</Text>
        <Text dimColor>{'  run = send now · preview = look before sending · Tab panes (wide)'}</Text>
        <Text dimColor>{'  result: j/k scroll the body (in a split pane, Tab to the right pane first)'}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Esc or ? to close</Text>
      </Box>
    </Box>
  );
}
