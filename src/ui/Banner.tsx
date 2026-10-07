import { Box, Text } from 'ink';
import { appVersion } from '../version';

// The mark: htui's initial, drawn with the same half-block strokes as the
// list cursor (pi-agent style — minimal, no letters to read).
const MARK = ['█ ░', '░▀█'];

/** Launch banner — shown only on the file picker screen. */
export function Banner({ files }: { files: number }) {
  return (
    <Box borderStyle="round" borderColor="gray" flexDirection="row" paddingX={1} alignSelf="flex-start" marginBottom={1}>
      <Box flexDirection="column" marginRight={2}>
        {MARK.map((line, i) => (
          <Text key={i} bold color="magenta">
            {line}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column">
        <Text>
          <Text bold>htui</Text>
          <Text dimColor> · http terminal ui</Text>
        </Text>
        <Text dimColor>{`v${appVersion()} · ${files} files ready`}</Text>
      </Box>
    </Box>
  );
}
