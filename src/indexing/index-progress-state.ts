import fs from "node:fs/promises";
import path from "node:path";
import type { IndexProgressEvent } from "../core/types.js";

export const INDEX_STATE_FILE = "index-state.json";
export const INDEX_PROGRESS_LOG_FILE = "index-progress.jsonl";

export interface PersistedIndexState {
  repoRoot: string;
  updatedAtMs: number;
  phase: IndexProgressEvent["phase"];
  message: string;
  event: IndexProgressEvent;
}

export interface IndexProgressRecorder {
  onProgress(event: IndexProgressEvent): void;
  recordFailure(error: unknown): Promise<void>;
  flush(): Promise<void>;
}

export function createIndexProgressRecorder(repoRoot: string): IndexProgressRecorder {
  let tail: Promise<void> = Promise.resolve();

  const enqueue = (event: IndexProgressEvent): Promise<void> => {
    tail = tail
      .catch(() => undefined)
      .then(() => recordIndexProgress(repoRoot, event))
      .catch(() => undefined);
    return tail;
  };

  return {
    onProgress(event) {
      void enqueue(event);
    },
    recordFailure(error) {
      return enqueue(failureEvent(error));
    },
    flush() {
      return tail.catch(() => undefined);
    }
  };
}

export async function recordIndexProgress(repoRoot: string, event: IndexProgressEvent): Promise<void> {
  const dir = ragcodeDir(repoRoot);
  const payload: PersistedIndexState = {
    repoRoot: path.resolve(repoRoot),
    updatedAtMs: Date.now(),
    phase: event.phase,
    message: event.message,
    event
  };
  await fs.mkdir(dir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(dir, INDEX_STATE_FILE), `${JSON.stringify(payload, null, 2)}\n`, "utf8"),
    fs.appendFile(path.join(dir, INDEX_PROGRESS_LOG_FILE), `${JSON.stringify(payload)}\n`, "utf8")
  ]);
}

export async function recordIndexFailure(repoRoot: string, error: unknown): Promise<void> {
  await recordIndexProgress(repoRoot, failureEvent(error));
}

function failureEvent(error: unknown): IndexProgressEvent {
  return {
    phase: "failed",
    message: error instanceof Error ? error.message : String(error)
  };
}

function ragcodeDir(repoRoot: string): string {
  return path.join(path.resolve(repoRoot), ".ragcode");
}
