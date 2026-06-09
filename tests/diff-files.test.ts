import { describe, expect, it } from "vitest";
import { extractChangedFiles } from "../src/graph/diff-files.js";

describe("diff changed file extraction", () => {
  it("extracts modified, added, renamed, and binary target paths", () => {
    const diff = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "index 1111111..2222222 100644",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+new",
      "diff --git a/src/old-name.ts b/src/new-name.ts",
      "similarity index 100%",
      "rename from src/old-name.ts",
      "rename to src/new-name.ts",
      "diff --git a/assets/logo.png b/assets/logo.png",
      "index 4444444..5555555 100644",
      "Binary files a/assets/logo.png and b/assets/logo.png differ"
    ].join("\n");

    expect(extractChangedFiles(diff)).toEqual([
      "assets/logo.png",
      "src/auth.ts",
      "src/new-name.ts",
      "src/new.ts"
    ]);
  });

  it("skips deleted files because reviewDiff only checks current changed paths", () => {
    const diff = [
      "diff --git a/src/deleted.ts b/src/deleted.ts",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/src/deleted.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-old"
    ].join("\n");

    expect(extractChangedFiles(diff)).toEqual([]);
  });
});
