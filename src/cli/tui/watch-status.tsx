import { render, Box, Text, useApp, useInput } from "ink";
import type { WatchDaemonStatus } from "../../watch/watch-daemon.js";

export interface WatchStatusAppProps {
  status: WatchDaemonStatus;
}

export function WatchStatusApp({ status }: WatchStatusAppProps): React.ReactElement {
  const { exit } = useApp();
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) exit();
  });

  const scheduler = status.scheduler;
  const healthColor = scheduler.lastError ? "red" : status.ready ? "green" : "yellow";
  const health = scheduler.lastError ? "error" : status.ready ? "ready" : "starting";

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">RagCode Watch</Text>
      <Text dimColor>repo: {status.repoRoot}</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text>Status: <Text color={healthColor}>{health}</Text> {status.running ? "running" : "stopped"}</Text>
        <Text>Events: buffered {status.bufferedEvents}, pending {scheduler.pendingFiles}, indexing {scheduler.indexingFiles}</Text>
        <Text>Scheduler: {scheduler.running ? "running" : "stopped"}, {scheduler.scheduled ? "scheduled" : "idle"}, {scheduler.indexing ? "indexing" : "not indexing"}</Text>
        <Text>Last indexed: {scheduler.lastIndexedAtMs ? new Date(scheduler.lastIndexedAtMs).toLocaleString() : "never in this session"}</Text>
        {scheduler.lastError ? <Text color="red">Last error: {scheduler.lastError}</Text> : null}
      </Box>
      <Text dimColor>Ctrl+C or Esc to stop</Text>
    </Box>
  );
}

export function createWatchStatusTui(initialStatus: WatchDaemonStatus): {
  update(status: WatchDaemonStatus): void;
  waitUntilExit(): Promise<void>;
  unmount(): void;
} {
  const app = render(<WatchStatusApp status={initialStatus} />);
  return {
    update(status) {
      app.rerender(<WatchStatusApp status={status} />);
    },
    async waitUntilExit() {
      await app.waitUntilExit();
    },
    unmount() {
      app.unmount();
    }
  };
}
