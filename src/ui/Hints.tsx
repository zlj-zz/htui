import { Text } from 'ink';
import { hintRowsFor, type Hint, type Step } from '../keys';

/**
 * Footer key hints for a screen, packed to the terminal width (a hint is never
 * split across lines — that is `hintRowsFor`'s contract). Color carries the
 * action hierarchy: the screen's primary action loudest, its verbs next, the
 * ever-present globals last.
 */
export function Hints({ step, indent = '' }: { step: Step; indent?: string }) {
  const width = (process.stdout.columns ?? 80) - indent.length;
  return (
    <>
      {hintRowsFor(step, width).map((line, i) => (
        <Text key={i}>
          {indent}
          {line.map((hint, j) => (
            <Text key={j}>
              {j > 0 ? '  ' : ''}
              <HintText hint={hint} />
            </Text>
          ))}
        </Text>
      ))}
    </>
  );
}

function HintText({ hint: { key, label, kind } }: { hint: Hint }) {
  if (kind === 'primary') {
    return (
      <>
        <Text bold color="cyan">
          [{key}]
        </Text>
        <Text bold> {label}</Text>
      </>
    );
  }
  if (kind === 'global') {
    return (
      <>
        <Text dimColor>[{key}]</Text>
        <Text dimColor> {label}</Text>
      </>
    );
  }
  // Screen verbs and the pane's own keys (j/k): accent on the key only.
  return (
    <>
      <Text color="cyan">[{key}]</Text>
      <Text dimColor={kind === 'app'}> {label}</Text>
    </>
  );
}
