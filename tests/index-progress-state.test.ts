import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIndexProgressRecorder, INDEX_STATE_FILE, type PersistedIndexState } from "../src/indexing/index-progress-state.js";

describe("index progress state", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the final state ordered even when an earlier progress write is slow", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-progress-"));
    let releaseSlowWrite: (() => void) | undefined;
    const originalWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation(async (file, data, options) => {
      if (String(file).endsWith(INDEX_STATE_FILE) && String(data).includes('"phase": "scanning_inventory"')) {
        await new Promise<void>((resolve) => {
          releaseSlowWrite = resolve;
        });
      }
      return originalWriteFile(file, data, options);
    });

    try {
      const recorder = createIndexProgressRecorder(root);
      recorder.onProgress({ phase: "scanning_inventory", message: "Scanning repository inventory" });
      recorder.onProgress({ phase: "complete", message: "Index complete" });

      await waitFor(() => releaseSlowWrite !== undefined);
      releaseSlowWrite?.();
      await recorder.flush();

      const state = JSON.parse(await fs.readFile(path.join(root, ".ragcode", INDEX_STATE_FILE), "utf8")) as PersistedIndexState;
      expect(state.phase).toBe("complete");
      expect(state.message).toBe("Index complete");
    } finally {
      releaseSlowWrite?.();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}
