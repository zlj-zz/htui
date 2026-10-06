import { Box, Text } from 'ink';

const SECTIONS: Array<{ title: string; keys: Array<[string, string]> }> = [
  {
    title: 'Anywhere',
    keys: [
      ['↑ ↓', 'move'],
      ['Enter', 'open / send'],
      ['Esc', 'clear filter, else back'],
      ['?', 'this help'],
      ['q', 'quit'],
    ],
  },
  {
    title: 'Lists',
    keys: [
      ['type', 'filter'],
      ['Ctrl-F', 'search requests across all files'],
      ['Ctrl-O', 'import an OpenAPI spec'],
      ['Ctrl-V', 'edit the highlighted request in $EDITOR'],
      ['Ctrl-E', 'switch environment'],
      ['Ctrl-R', 'run-chain (run prerequisites first)'],
    ],
  },
  {
    title: 'Result',
    keys: [
      ['r', 'rerun'],
      ['e', 'edit the request in $EDITOR'],
      ['v', 'edit the variables file'],
      ['t', 'session history'],
      ['b', 'back'],
    ],
  },
];

export function Help() {
  return (
    <Box flexDirection="column">
      <Text bold>htui · keys</Text>
      {SECTIONS.map((section) => (
        <Box key={section.title} flexDirection="column" marginTop={1}>
          <Text color="cyan">{section.title}</Text>
          {section.keys.map(([key, label]) => (
            <Text key={key}>
              {'  '}
              {key.padEnd(8)}
              <Text dimColor>{label}</Text>
            </Text>
          ))}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>Esc or ? to close</Text>
      </Box>
    </Box>
  );
}
