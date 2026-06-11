import { render, Box, Text } from "ink";
import type { IndexProgressEvent, RepoIndex } from "../../core/types.js";

export interface IndexProgressAppProps {
  repoRoot: string;
  events: IndexProgressEvent[];
  result?: RepoIndex;
  error?: string;
}

export function IndexProgressApp({ repoRoot, events, result, error }: IndexProgressAppProps): React.ReactElement {
  const latest = events.at(-1);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">RagCode Index</Text>
      <Text dimColor>repo: {repoRoot}</Text>
      <Box flexDirection="column" marginTop={1}>
        {events.slice(-6).map((event, index) => (
          <Text key={`${event.phase}-${index}`} color={index === events.slice(-6).length - 1 && !result && !error ? "green" : undefined}>
            {event.phase === "complete" ? "✓" : "•"} {event.message}{formatEventStats(event)}
          </Text>
        ))}
        {!latest ? <Text>• Preparing index</Text> : null}
      </Box>
      {result ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green">Indexed {result.files.length} files, {result.chunks.length} chunks.</Text>
          <Text dimColor>changed {result.changedFiles.length}, deleted {result.deletedFiles.length}, refreshed {result.refreshedFiles?.length ?? 0}</Text>
        </Box>
      ) : null}
      {error ? <Text color="red">Index failed: {error}</Text> : null}
    </Box>
  );
}

export async function runIndexProgressTui(options: {
  repoRoot: string;
  run: (onProgress: (event: IndexProgressEvent) => void) => Promise<RepoIndex>;
}): Promise<RepoIndex> {
  const events: IndexProgressEvent[] = [];
  let result: RepoIndex | undefined;
  let error: string | undefined;

  const app = render(<IndexProgressApp repoRoot={options.repoRoot} events={events} />);

  const update = (): void => {
    app.rerender(<IndexProgressApp repoRoot={options.repoRoot} events={[...events]} result={result} error={error} />);
  };

  try {
    result = await options.run((event) => {
      events.push(event);
      update();
    });
    update();
    return result;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    update();
    throw caught;
  } finally {
    app.unmount();
  }
}

function formatEventStats(event: IndexProgressEvent): string {
  const parts: string[] = [];
  if (event.scannedFiles !== undefined) parts.push(`scanned ${event.scannedFiles}`);
  if (event.changedFiles !== undefined) parts.push(`changed ${event.changedFiles}`);
  if (event.deletedFiles !== undefined) parts.push(`deleted ${event.deletedFiles}`);
  if (event.refreshedFiles !== undefined) parts.push(`refreshed ${event.refreshedFiles}`);
  if (event.chunks !== undefined) parts.push(`chunks ${event.chunks}`);
  if (event.symbols !== undefined) parts.push(`symbols ${event.symbols}`);
  if (event.edges !== undefined) parts.push(`edges ${event.edges}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}
