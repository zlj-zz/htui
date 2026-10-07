import { Text } from 'ink';
import { hintLines, type Step } from '../keys';

/**
 * Footer key hints for a screen, packed to the terminal width (a hint is never
 * split across lines — that is `hintLines`' contract).
 */
export function Hints({ step, indent = '' }: { step: Step; indent?: string }) {
  const width = (process.stdout.columns ?? 80) - indent.length;
  return (
    <>
      {hintLines(step, width).map((line, i) => (
        <Text key={i} dimColor>
          {indent}
          {line}
        </Text>
      ))}
    </>
  );
}
