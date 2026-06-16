#!/usr/bin/env node
import path from "node:path";
import {
  WatcherLockError,
  acquireWatcherLock,
  startHeartbeatKeepalive,
  writeHeartbeatSync,
  type HeartbeatKeepaliveHandle,
  type WatcherLockHandle
} from "../watch/watcher-liveness.js";
import type { RagCodeEngine } from "../core/engine.js";
import type { FileWatchDaemonOptions } from "../watch/watch-daemon.js";

interface WatchServiceOptions {
  repoRoot: string;
  daemonOptions: FileWatchDaemonOptions;
}

function parseArgs(argv: string[]): WatchServiceOptions {
  const [command, repoRoot, ...rest] = argv;
  if (command !== "watch" || !repoRoot) {
    throw new Error("Usage: watch-service-entry watch <repoRoot> [--no-index-on-start] [--poll] [watch options]");
  }
  const options: FileWatchDaemonOptions = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    switch (arg) {
      case "--no-index-on-start":
        options.indexOnStart = false;
        break;
      case "--poll":
        options.usePolling = true;
        break;
      case "--batch-delay":
        options.batchDelayMs = parsePositiveNumber(arg, rest[++index]);
        break;
      case "--quiet":
        options.minQuietMs = parsePositiveNumber(arg, rest[++index]);
        break;
      case "--flush-events":
        options.flushEventsMs = parsePositiveNumber(arg, rest[++index]);
        break;
      case "--await-write":
        options.awaitWriteFinishMs = parsePositiveNumber(arg, rest[++index]);
        break;
      case "--burst-threshold":
        options.burstThreshold = parsePositiveNumber(arg, rest[++index]);
        break;
      case "--max-dirty-files":
        options.maxDirtyFiles = parsePositiveNumber(arg, rest[++index]);
        break;
      case "--max-batch-files":
        options.maxBatchFiles = parsePositiveNumber(arg, rest[++index]);
        break;
      case "--max-analysis-memory-mb":
        options.maxAnalysisMemoryMb = parsePositiveNumber(arg, rest[++index]);
        break;
      case "--no-auto-index":
        options.autoIndex = false;
        break;
      default:
        throw new Error(`Unknown watch service option: ${arg}`);
    }
  }
  return { repoRoot, daemonOptions: options };
}

function parsePositiveNumber(name: string, raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

async function createEngine(repoRoot: string): Promise<RagCodeEngine> {
  const [{ createRuntimeComponentsForRepo }, { RagCodeEngine }] = await Promise.all([
    import("../config/runtime-config.js"),
    import("../core/engine.js")
  ]);
  const components = createRuntimeComponentsForRepo({
    cwd: process.cwd(),
    overrides: { repoRoot }
  });
  return new RagCodeEngine({
    cwd: repoRoot,
    graphStore: components.graphStore,
    semanticStore: components.semanticStore,
    embeddingProvider: components.embeddingProvider
  });
}

function startStartupHeartbeat(repoRoot: string, lockHandle: WatcherLockHandle): HeartbeatKeepaliveHandle {
  const heartbeat = {
    pid: lockHandle.info.pid,
    hostname: lockHandle.info.hostname,
    repoRoot: lockHandle.info.repoRoot,
    startedAtMs: lockHandle.info.startedAtMs,
    lastHeartbeatMs: Date.now(),
    pendingFiles: 0,
    indexingFiles: 0,
    ready: false
  };
  try {
    writeHeartbeatSync(repoRoot, heartbeat);
  } catch {
    // Lock ownership is the correctness boundary; heartbeat is best-effort observability.
  }
  return startHeartbeatKeepalive(repoRoot, lockHandle.info, 5_000);
}

async function main(): Promise<void> {
  const { repoRoot, daemonOptions } = parseArgs(process.argv.slice(2));
  const absoluteRoot = path.resolve(repoRoot);
  let lockHandle: WatcherLockHandle;
  try {
    lockHandle = acquireWatcherLock(absoluteRoot);
  } catch (error) {
    if (error instanceof WatcherLockError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  const startupHeartbeat = startStartupHeartbeat(absoluteRoot, lockHandle);
  let engine: RagCodeEngine;
  try {
    const [{ loadDotEnv }] = await Promise.all([import("../config/dotenv.js")]);
    loadDotEnv();
    engine = await createEngine(absoluteRoot);
  } catch (error) {
    startupHeartbeat.stop();
    lockHandle.release();
    throw error;
  }
  const { FileWatchDaemon } = await import("../watch/watch-daemon.js");
  const daemon = new FileWatchDaemon(engine, absoluteRoot, {
    ...daemonOptions,
    lifecycleLockHandle: lockHandle,
    onStatus: (status) => {
      startupHeartbeat.stop();
      console.error(JSON.stringify({ watcher: status }));
    }
  });
  const shutdown = async (): Promise<void> => {
    startupHeartbeat.stop();
    await daemon.stop();
    engine.close();
  };
  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
  try {
    await daemon.start();
  } catch (error) {
    startupHeartbeat.stop();
    await daemon.stop();
    engine.close();
    throw error;
  }
  console.log(JSON.stringify(await daemon.status(), null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
