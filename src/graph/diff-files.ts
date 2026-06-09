import parseDiff from "parse-diff";
import { normalizeUserPath } from "../utils/path.js";

export function extractChangedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const file of parseDiff(diff)) {
    if (file.deleted) continue;
    const target = file.to ?? file.from;
    if (!target || target === "/dev/null") continue;
    files.add(normalizeUserPath(target));
  }
  return [...files].sort();
}
