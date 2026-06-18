import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listIndexableFilePaths, scanRepo } from "../src/indexing/scanner.js";

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

  it("honors the repository .gitignore when listing bootstrap candidates", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-inventory-gitignore-"));
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, ".omc", "state"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "scratch-gui", "build"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "scratch-gui", "src"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "ignored"), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, ".gitignore"),
      [
        ".omc/",
        "scratch-gui/build/",
        "ignored/*.ts",
        "!ignored/keep.ts"
      ].join("\n")
    );
    await fs.writeFile(path.join(tempRoot, "src", "app.ts"), "export const app = 1;\n");
    await fs.writeFile(path.join(tempRoot, ".omc", "state", "session.json"), "{\"runtime\":true}\n");
    await fs.writeFile(path.join(tempRoot, "scratch-gui", "build", "bundle.ts"), "export const bundle = 1;\n");
    await fs.writeFile(path.join(tempRoot, "scratch-gui", "src", "gui.ts"), "export const gui = 1;\n");
    await fs.writeFile(path.join(tempRoot, "ignored", "drop.ts"), "export const drop = 1;\n");
    await fs.writeFile(path.join(tempRoot, "ignored", "keep.ts"), "export const keep = 1;\n");

    const inventory = await listIndexableFilePaths(tempRoot);

    expect(inventory.filePaths).toEqual(["ignored/keep.ts", "scratch-gui/src/gui.ts", "src/app.ts"]);
    expect(inventory.skippedFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: ".omc", reason: "gitignore pattern: .omc/" }),
      expect.objectContaining({ filePath: "scratch-gui/build", reason: "ignored directory: build" }),
      expect.objectContaining({ filePath: "ignored/drop.ts", reason: "gitignore pattern: ignored/*.ts" })
    ]));
  });

  it("honors the repository .gitignore during full index scans", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-scan-gitignore-"));
    await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, ".omc"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "ignored"), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, ".gitignore"),
      [
        ".omc/",
        "ignored/*.ts",
        "!ignored/keep.ts"
      ].join("\n")
    );
    await fs.writeFile(path.join(tempRoot, "src", "app.ts"), "export const app = 1;\n");
    await fs.writeFile(path.join(tempRoot, ".omc", "session.json"), "{\"runtime\":true}\n");
    await fs.writeFile(path.join(tempRoot, "ignored", "drop.ts"), "export const drop = 1;\n");
    await fs.writeFile(path.join(tempRoot, "ignored", "keep.ts"), "export const keep = 1;\n");

    const scan = await scanRepo(tempRoot, "project");

    expect(scan.files.map((file) => file.path)).toEqual(["ignored/keep.ts", "src/app.ts"]);
    expect(scan.skippedFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: ".omc", reason: "gitignore pattern: .omc/" }),
      expect.objectContaining({ filePath: "ignored/drop.ts", reason: "gitignore pattern: ignored/*.ts" })
    ]));
  });
});
