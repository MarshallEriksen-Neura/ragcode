import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listIndexableFilePaths } from "../src/indexing/scanner.js";

let tempRoot: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

describe("scanner inventory", () => {
  it("lists bootstrap candidates without reading file contents", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-inventory-"));
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "src", "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(tempRoot, "src", "b.ts"), "export const b = 2;\n");
    await fs.writeFile(path.join(tempRoot, ".env"), "SECRET=hidden\n");
    const readFile = vi.spyOn(fs, "readFile");

    const inventory = await listIndexableFilePaths(tempRoot);

    expect(inventory.filePaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(inventory.skippedFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: ".env", reason: "sensitive file policy" })
    ]));
    expect(readFile).not.toHaveBeenCalled();
  });
});
