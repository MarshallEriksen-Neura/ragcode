import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEARTBEAT_STALE_MS,
  WatcherLockError,
  acquireWatcherLock,
  clearHeartbeat,
  readWatcherLiveness,
  watcherHeartbeatPath,
  watcherLockPath,
  writeHeartbeat,
  type WatcherHeartbeat
} from "../src/watch/watcher-liveness.js";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function createTempRepo(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ragcode-liveness-"));
  tempRoots.push(root);
  return root;
}

function heartbeatFor(repoRoot: string, overrides: Partial<WatcherHeartbeat> = {}): WatcherHeartbeat {
  return {
    pid: process.pid,
    hostname: os.hostname(),
    repoRoot: path.resolve(repoRoot),
    startedAtMs: Date.now(),
    lastHeartbeatMs: Date.now(),
    pendingFiles: 0,
    indexingFiles: 0,
    ready: true,
    ...overrides
  };
}

describe("watcher liveness", () => {
  it("acquires a lock and writes a parseable lock file", async () => {
    const root = await createTempRepo();
    const handle = acquireWatcherLock(root);
    try {
      expect(handle.info.pid).toBe(process.pid);
      expect(fs.existsSync(watcherLockPath(root))).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(watcherLockPath(root), "utf8"));
      expect(parsed.pid).toBe(process.pid);
      expect(parsed.repoRoot).toBe(path.resolve(root));
    } finally {
      handle.release();
    }
    // release removes the lock file
    expect(fs.existsSync(watcherLockPath(root))).toBe(false);
  });

  it("refuses a second lock held by a live process on the same host", async () => {
    const root = await createTempRepo();
    const first = acquireWatcherLock(root);
    try {
      expect(() => acquireWatcherLock(root)).toThrow(WatcherLockError);
    } finally {
      first.release();
    }
    // after release, the lock is acquirable again
    const second = acquireWatcherLock(root);
    second.release();
  });

  it("reclaims a stale lock left by a dead pid", async () => {
    const root = await createTempRepo();
    // Write a lock owned by an impossible/dead pid on this host.
    fs.mkdirSync(path.dirname(watcherLockPath(root)), { recursive: true });
    fs.writeFileSync(
      watcherLockPath(root),
      JSON.stringify({ pid: 2_147_483_646, hostname: os.hostname(), repoRoot: path.resolve(root), startedAtMs: 1 }),
      "utf8"
    );
    const handle = acquireWatcherLock(root);
    expect(handle.info.pid).toBe(process.pid);
    handle.release();
  });

  it("reports not_running when neither lock nor heartbeat exist", async () => {
    const root = await createTempRepo();
    const liveness = await readWatcherLiveness(root);
    expect(liveness.state).toBe("not_running");
    expect(liveness.processAlive).toBe(false);
    expect(liveness.heartbeatFresh).toBe(false);
  });

  it("reports running with a live lock and fresh heartbeat", async () => {
    const root = await createTempRepo();
    const handle = acquireWatcherLock(root);
    try {
      await writeHeartbeat(root, heartbeatFor(root, { pid: process.pid }));
      const liveness = await readWatcherLiveness(root);
      expect(liveness.state).toBe("running");
      expect(liveness.processAlive).toBe(true);
      expect(liveness.heartbeatFresh).toBe(true);
    } finally {
      handle.release();
      await clearHeartbeat(root);
    }
  });

  it("reports stale when the process is alive but the heartbeat is old", async () => {
    const root = await createTempRepo();
    const handle = acquireWatcherLock(root);
    try {
      await writeHeartbeat(root, heartbeatFor(root, { pid: process.pid, lastHeartbeatMs: Date.now() - HEARTBEAT_STALE_MS - 5_000 }));
      const liveness = await readWatcherLiveness(root);
      expect(liveness.state).toBe("stale");
      expect(liveness.processAlive).toBe(true);
      expect(liveness.heartbeatFresh).toBe(false);
    } finally {
      handle.release();
      await clearHeartbeat(root);
    }
  });

  it("reports dead when a lock points at a dead pid", async () => {
    const root = await createTempRepo();
    fs.mkdirSync(path.dirname(watcherLockPath(root)), { recursive: true });
    fs.writeFileSync(
      watcherLockPath(root),
      JSON.stringify({ pid: 2_147_483_646, hostname: os.hostname(), repoRoot: path.resolve(root), startedAtMs: 1 }),
      "utf8"
    );
    await writeHeartbeat(root, heartbeatFor(root, { pid: 2_147_483_646, lastHeartbeatMs: Date.now() - HEARTBEAT_STALE_MS - 5_000 }));
    const liveness = await readWatcherLiveness(root);
    expect(liveness.state).toBe("dead");
    expect(liveness.processAlive).toBe(false);
  });

  it("clearHeartbeat removes the heartbeat file", async () => {
    const root = await createTempRepo();
    await writeHeartbeat(root, heartbeatFor(root));
    expect(fs.existsSync(watcherHeartbeatPath(root))).toBe(true);
    await clearHeartbeat(root);
    expect(fs.existsSync(watcherHeartbeatPath(root))).toBe(false);
  });
});
