import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

// Cross-process liveness for the watch daemon. Two files under <repo>/.ragcode/:
//
//   watcher.lock      — pid-stamped advisory lock. Acquired on `ragcode watch` start;
//                       a second watcher on the same repo refuses rather than double-indexing.
//   watcher-heartbeat.json — periodically rewritten with last-heartbeat / last-index /
//                       backlog so doctor, dashboard, and MCP can answer
//                       "is a watcher alive and current?" with only a file read (no IPC).
//
// Both live inside .ragcode/, which the watcher's ignore policy already excludes, so writing
// them never feeds back as a file event.

export const WATCHER_LOCK_FILE = "watcher.lock";
export const WATCHER_HEARTBEAT_FILE = "watcher-heartbeat.json";

// A heartbeat older than this is treated as a dead/hung daemon. The daemon writes a heartbeat
// on every scheduler tick and on a fixed liveness interval, both well under this bound.
export const HEARTBEAT_STALE_MS = 30_000;

export interface WatcherLockInfo {
  pid: number;
  hostname: string;
  repoRoot: string;
  startedAtMs: number;
}

export interface WatcherHeartbeat {
  pid: number;
  hostname: string;
  repoRoot: string;
  startedAtMs: number;
  lastHeartbeatMs: number;
  lastIndexedAtMs?: number;
  pendingFiles: number;
  indexingFiles: number;
  ready: boolean;
  lastError?: string;
}

export type WatcherLivenessState = "running" | "stale" | "dead" | "not_running";

export interface WatcherLiveness {
  state: WatcherLivenessState;
  /** True only when a lock holder process is actually alive on this host. */
  processAlive: boolean;
  /** True when a heartbeat exists and is within HEARTBEAT_STALE_MS. */
  heartbeatFresh: boolean;
  diagnostic: "live_watcher" | "stale_heartbeat" | "dead_lock_holder" | "heartbeat_without_lock" | "lock_without_heartbeat" | "not_running";
  nextAction?: string;
  lock?: WatcherLockInfo;
  heartbeat?: WatcherHeartbeat;
  heartbeatAgeMs?: number;
}

function ragcodeDir(repoRoot: string): string {
  return path.join(path.resolve(repoRoot), ".ragcode");
}

export function watcherLockPath(repoRoot: string): string {
  return path.join(ragcodeDir(repoRoot), WATCHER_LOCK_FILE);
}

export function watcherHeartbeatPath(repoRoot: string): string {
  return path.join(ragcodeDir(repoRoot), WATCHER_HEARTBEAT_FILE);
}

// `process.kill(pid, 0)` sends no signal; it only probes whether the pid exists and is
// signalable by us. ESRCH = gone, EPERM = alive but owned by another user (still "alive").
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockSync(repoRoot: string): WatcherLockInfo | undefined {
  try {
    const raw = fs.readFileSync(watcherLockPath(repoRoot), "utf8");
    const parsed = JSON.parse(raw) as Partial<WatcherLockInfo>;
    if (typeof parsed.pid !== "number") return undefined;
    return {
      pid: parsed.pid,
      hostname: typeof parsed.hostname === "string" ? parsed.hostname : "",
      repoRoot: typeof parsed.repoRoot === "string" ? parsed.repoRoot : path.resolve(repoRoot),
      startedAtMs: typeof parsed.startedAtMs === "number" ? parsed.startedAtMs : 0
    };
  } catch {
    return undefined;
  }
}

export function isWatcherLockOwner(repoRoot: string, owner: WatcherLockInfo): boolean {
  const current = readLockSync(repoRoot);
  return Boolean(
    current &&
      current.pid === owner.pid &&
      current.hostname === owner.hostname &&
      path.resolve(current.repoRoot) === path.resolve(owner.repoRoot) &&
      current.startedAtMs === owner.startedAtMs
  );
}

export class WatcherLockError extends Error {
  constructor(
    message: string,
    readonly existing: WatcherLockInfo
  ) {
    super(message);
    this.name = "WatcherLockError";
  }
}

export interface WatcherLockHandle {
  readonly info: WatcherLockInfo;
  release(): void;
}

export interface HeartbeatKeepaliveHandle {
  stop(): void;
}

// Acquire the per-repo watcher lock. Throws WatcherLockError if a live watcher already holds it.
// A lock left behind by a crashed process (pid no longer alive, or a different host) is treated
// as stale and reclaimed. Acquisition is atomic via O_EXCL with a takeover fallback.
export function acquireWatcherLock(repoRoot: string): WatcherLockHandle {
  const resolvedRoot = path.resolve(repoRoot);
  const lockPath = watcherLockPath(resolvedRoot);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const info: WatcherLockInfo = {
    pid: process.pid,
    hostname: os.hostname(),
    repoRoot: resolvedRoot,
    startedAtMs: Date.now()
  };
  const payload = `${JSON.stringify(info, null, 2)}\n`;

  const writeExclusive = (): boolean => {
    try {
      fs.writeFileSync(lockPath, payload, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  };

  if (!writeExclusive()) {
    const existing = readLockSync(resolvedRoot);
    const heldByLiveProcess =
      existing !== undefined && existing.hostname === info.hostname && isProcessAlive(existing.pid);
    if (heldByLiveProcess) {
      throw new WatcherLockError(
        `A watcher is already running for ${resolvedRoot} (pid ${existing!.pid}).`,
        existing!
      );
    }
    // Stale lock (crashed pid, or a lock from another host that can't be verified here):
    // reclaim it. The takeover write is not O_EXCL because we've decided the holder is gone.
    fs.writeFileSync(lockPath, payload, { flag: "w" });
  }

  let released = false;
  return {
    info,
    release(): void {
      if (released) return;
      released = true;
      // Only remove the lock if we still own it — guards against deleting a lock a newer
      // watcher reclaimed after we were declared stale.
      if (isWatcherLockOwner(resolvedRoot, info)) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // Best-effort: a missing lock on release is fine.
        }
      }
    }
  };
}

export async function writeHeartbeat(repoRoot: string, heartbeat: WatcherHeartbeat): Promise<void> {
  const heartbeatPath = watcherHeartbeatPath(repoRoot);
  await fsp.mkdir(path.dirname(heartbeatPath), { recursive: true });
  await fsp.writeFile(heartbeatPath, `${JSON.stringify(heartbeat, null, 2)}\n`, "utf8");
}

export function writeHeartbeatSync(repoRoot: string, heartbeat: WatcherHeartbeat): void {
  const heartbeatPath = watcherHeartbeatPath(repoRoot);
  fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
  fs.writeFileSync(heartbeatPath, `${JSON.stringify(heartbeat, null, 2)}\n`, "utf8");
}

export function startHeartbeatKeepalive(
  repoRoot: string,
  owner: WatcherLockInfo,
  intervalMs = 10_000
): HeartbeatKeepaliveHandle {
  const worker = new Worker(`
    const fs = require("node:fs");
    const path = require("node:path");
    const { parentPort, workerData } = require("node:worker_threads");

    function readJson(filePath) {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        return undefined;
      }
    }

    function ownsLock() {
      const current = readJson(workerData.lockPath);
      return Boolean(
        current &&
          current.pid === workerData.owner.pid &&
          current.hostname === workerData.owner.hostname &&
          path.resolve(current.repoRoot) === path.resolve(workerData.owner.repoRoot) &&
          current.startedAtMs === workerData.owner.startedAtMs
      );
    }

    function heartbeat() {
      if (!ownsLock()) return;
      const current = readJson(workerData.heartbeatPath) || {};
      const next = {
        ...current,
        pid: workerData.owner.pid,
        hostname: workerData.owner.hostname,
        repoRoot: workerData.owner.repoRoot,
        startedAtMs: workerData.owner.startedAtMs,
        lastHeartbeatMs: Date.now(),
        pendingFiles: typeof current.pendingFiles === "number" ? current.pendingFiles : 0,
        indexingFiles: typeof current.indexingFiles === "number" ? current.indexingFiles : 0,
        ready: typeof current.ready === "boolean" ? current.ready : false
      };
      fs.mkdirSync(path.dirname(workerData.heartbeatPath), { recursive: true });
      fs.writeFileSync(workerData.heartbeatPath, JSON.stringify(next, null, 2) + "\\n", "utf8");
    }

    heartbeat();
    const timer = setInterval(heartbeat, workerData.intervalMs);
    parentPort.on("message", (message) => {
      if (message === "stop") {
        clearInterval(timer);
        process.exit(0);
      }
    });
  `, {
    eval: true,
    workerData: {
      heartbeatPath: watcherHeartbeatPath(repoRoot),
      lockPath: watcherLockPath(repoRoot),
      owner,
      intervalMs
    }
  });
  worker.unref();
  return {
    stop(): void {
      worker.postMessage("stop");
      void worker.terminate().catch(() => undefined);
    }
  };
}

export async function clearHeartbeat(repoRoot: string): Promise<void> {
  await fsp.rm(watcherHeartbeatPath(repoRoot), { force: true }).catch(() => undefined);
}

async function readHeartbeat(repoRoot: string): Promise<WatcherHeartbeat | undefined> {
  try {
    const raw = await fsp.readFile(watcherHeartbeatPath(repoRoot), "utf8");
    const parsed = JSON.parse(raw) as Partial<WatcherHeartbeat>;
    if (typeof parsed.pid !== "number" || typeof parsed.lastHeartbeatMs !== "number") return undefined;
    return parsed as WatcherHeartbeat;
  } catch {
    return undefined;
  }
}

// Read-only liveness probe used by doctor / dashboard / MCP. Combines the lock (does a holder
// process exist?) with the heartbeat (is it current?) into one verdict. Pure reads — never
// mutates lock or heartbeat, so it is safe to call from any process.
export async function readWatcherLiveness(repoRoot: string, nowMs = Date.now()): Promise<WatcherLiveness> {
  const lock = readLockSync(repoRoot);
  const heartbeat = await readHeartbeat(repoRoot);
  const sameHost = lock ? lock.hostname === os.hostname() : false;
  // Off-host locks can't be probed with process.kill; trust a fresh heartbeat instead.
  const processAlive = lock ? (sameHost ? isProcessAlive(lock.pid) : Boolean(heartbeat)) : false;
  const heartbeatAgeMs = heartbeat ? Math.max(0, nowMs - heartbeat.lastHeartbeatMs) : undefined;
  const heartbeatFresh = heartbeatAgeMs !== undefined && heartbeatAgeMs <= HEARTBEAT_STALE_MS;

  let state: WatcherLivenessState;
  let diagnostic: WatcherLiveness["diagnostic"];
  let nextAction: string | undefined;
  if (!lock && !heartbeat) {
    state = "not_running";
    diagnostic = "not_running";
  } else if (processAlive && heartbeatFresh) {
    state = "running";
    diagnostic = "live_watcher";
  } else if (processAlive && !heartbeatFresh) {
    state = "stale";
    diagnostic = heartbeat ? "stale_heartbeat" : "lock_without_heartbeat";
    nextAction = "Check the watcher process; status is read-only and will not remove lifecycle files.";
  } else if (!lock && heartbeat) {
    state = "dead";
    diagnostic = "heartbeat_without_lock";
    nextAction = "Run ragcode watch to replace stale heartbeat state.";
  } else {
    state = "dead";
    diagnostic = "dead_lock_holder";
    nextAction = "Next watcher acquisition will reclaim the stale lock.";
  }

  return { state, processAlive, heartbeatFresh, diagnostic, nextAction, lock, heartbeat, heartbeatAgeMs };
}
