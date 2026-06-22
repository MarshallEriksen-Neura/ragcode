import { render, renderToString, Box, Text } from "ink";
import type { IndexStatus } from "../../core/types.js";
import type { WatcherLiveness } from "../../watch/watcher-liveness.js";

export interface HumanStatusAppProps {
  status: IndexStatus;
  watcher: WatcherLiveness;
}

export function HumanStatusApp({ status, watcher }: HumanStatusAppProps): React.ReactElement {
  const indexedFiles = Math.max(0, status.fileCount - status.staleFileCount);
  const pendingFiles = status.pendingFileCount;
  const health = healthSummary(status, watcher);
  const embedding = embeddingSummary(status);
  const watcherLine = watcherSummary(watcher);
  const dirtySamples = status.freshness.dirtyFiles.slice(0, 5).map((file) => `${file.filePath} (${file.status})`);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">RagCode Status</Text>
      <Text dimColor>repo: {status.repoRoot}</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text>Health: <Text color={health.color}>{health.label}</Text></Text>
        <Text>Watch: <Text color={watcher.state === "running" ? "green" : "yellow"}>{watcherLine}</Text></Text>
        <Text>Files: indexed {indexedFiles}/{status.fileCount}, pending {pendingFiles}, stale {status.staleFileCount}, skipped {status.skippedFileCount}</Text>
        <Text>Graph: {status.graphFresh ? <Text color="green">fresh</Text> : <Text color="yellow">needs refresh</Text>} generation {status.freshness.indexGeneration}</Text>
        <Text>Embedding: <Text color={embedding.color}>{embedding.label}</Text> generation {status.semanticGeneration}, coverage {status.semanticCoverage}</Text>
        <Text>Chunks/Symbols/Edges: {status.chunkCount} / {status.symbolCount} / {status.edgeCount}</Text>
        {status.indexingFileCount > 0 ? <Text color="green">Indexing now: {status.indexingFileCount} file(s)</Text> : null}
        {watcher.heartbeat?.lastIndexedAtMs ? <Text>Last indexed: {formatDate(watcher.heartbeat.lastIndexedAtMs)}</Text> : null}
        {watcher.heartbeatAgeMs !== undefined ? <Text dimColor>Watcher heartbeat age: {formatDuration(watcher.heartbeatAgeMs)}</Text> : null}
        {status.semanticLastError ? <Text color="red">Embedding error: {status.semanticLastError}</Text> : null}
        {watcher.diagnostic ? <Text color="yellow">Watcher diagnostic: {watcher.diagnostic}</Text> : null}
        {dirtySamples.length > 0 ? <Text dimColor>Dirty files: {dirtySamples.join(", ")}{status.freshness.dirtyFiles.length > dirtySamples.length ? ", ..." : ""}</Text> : null}
        {status.burstMode ? <Text color="yellow">Burst mode: active, dropped/compressed {status.droppedEventCount} event(s)</Text> : null}
      </Box>
    </Box>
  );
}

export function renderHumanStatusText(status: IndexStatus, watcher: WatcherLiveness): string {
  return renderToString(<HumanStatusApp status={status} watcher={watcher} />);
}

export function runHumanStatusTui(status: IndexStatus, watcher: WatcherLiveness): void {
  render(<HumanStatusApp status={status} watcher={watcher} />);
}

function healthSummary(status: IndexStatus, watcher: WatcherLiveness): { label: string; color: "green" | "yellow" | "red" } {
  if (status.semanticLastError || watcher.state === "dead") return { label: "attention needed", color: "red" };
  if (!status.graphFresh || !status.semanticFresh || status.pendingFileCount > 0 || status.staleFileCount > 0) {
    return { label: "catching up", color: "yellow" };
  }
  return { label: "healthy", color: "green" };
}

function embeddingSummary(status: IndexStatus): { label: string; color: "green" | "yellow" | "red" } {
  if (status.semanticLastError) return { label: "failed", color: "red" };
  if (status.semanticRebuildNeeded) return { label: "rebuild needed", color: "yellow" };
  if (!status.semanticFresh) return { label: "stale", color: "yellow" };
  return { label: "fresh", color: "green" };
}

function watcherSummary(watcher: WatcherLiveness): string {
  const heartbeat = watcher.heartbeatFresh ? "fresh heartbeat" : "no fresh heartbeat";
  if (watcher.state === "running") return `running, ${heartbeat}`;
  if (watcher.state === "not_running") return "not running";
  return `${watcher.state}, ${heartbeat}`;
}

function formatDate(value: number): string {
  return new Date(value).toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}
