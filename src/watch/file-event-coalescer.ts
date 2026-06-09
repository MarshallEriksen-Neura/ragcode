import path from "node:path";
import type { WatcherEventOptions } from "../core/types.js";
import { normalizeRepoPath, normalizeUserPath } from "../utils/path.js";

export interface CoalescedFileEvents {
  dirtyFiles: string[];
  burstMode: boolean;
  droppedEvents: number;
  eventCountByFile: Map<string, number>;
  lastEventAtMs: number;
}

const DEFAULT_BURST_THRESHOLD = 100;
const DEFAULT_MAX_DIRTY_FILES = 1_000;

export function coalesceFileEvents(repoRoot: string, filePaths: string[], options: WatcherEventOptions = {}): CoalescedFileEvents {
  const eventCountByFile = new Map<string, number>();
  for (const filePath of filePaths) {
    const normalized = normalizeEventPath(repoRoot, filePath);
    if (!normalized) continue;
    eventCountByFile.set(normalized, (eventCountByFile.get(normalized) ?? 0) + 1);
  }

  const maxDirtyFiles = options.maxDirtyFiles ?? DEFAULT_MAX_DIRTY_FILES;
  const burstThreshold = options.burstThreshold ?? DEFAULT_BURST_THRESHOLD;
  const allDirtyFiles = [...eventCountByFile.keys()].sort();
  const dirtyFiles = allDirtyFiles.slice(0, maxDirtyFiles);
  const droppedEvents = Math.max(0, allDirtyFiles.length - dirtyFiles.length);
  const burstMode = allDirtyFiles.length >= burstThreshold || droppedEvents > 0;
  const keptCounts = new Map(dirtyFiles.map((filePath) => [filePath, eventCountByFile.get(filePath) ?? 1]));

  return {
    dirtyFiles,
    burstMode,
    droppedEvents,
    eventCountByFile: keptCounts,
    lastEventAtMs: Date.now()
  };
}

function normalizeEventPath(repoRoot: string, filePath: string): string | undefined {
  const trimmed = filePath.trim();
  if (!trimmed) return undefined;
  if (path.isAbsolute(trimmed)) {
    const relative = normalizeRepoPath(repoRoot, path.resolve(trimmed));
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    return relative;
  }
  return normalizeUserPath(trimmed);
}
