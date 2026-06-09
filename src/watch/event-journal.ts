import fs from "node:fs/promises";
import path from "node:path";
import { normalizeRepoPath, normalizeUserPath } from "../utils/path.js";

export interface WatchEventJournalEntry {
  event: "add" | "change" | "unlink" | "addDir" | "unlinkDir";
  filePath: string;
  observedAtMs: number;
}

export class FileEventJournal {
  constructor(readonly journalPath: string, private readonly repoRoot?: string) {}

  static forRepo(repoRoot: string, fileName = "watch-events.jsonl"): FileEventJournal {
    return new FileEventJournal(path.join(repoRoot, ".ragcode", fileName), path.resolve(repoRoot));
  }

  async append(entry: WatchEventJournalEntry): Promise<void> {
    await fs.mkdir(path.dirname(this.journalPath), { recursive: true });
    await fs.appendFile(this.journalPath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  async replay(): Promise<WatchEventJournalEntry[]> {
    const content = await fs.readFile(this.journalPath, "utf8").catch((error: unknown) => {
      if (isNotFound(error)) return "";
      throw error;
    });
    const entries: WatchEventJournalEntry[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = parseEntry(line);
      if (parsed) entries.push(parsed);
    }
    return entries;
  }

  async replayPaths(): Promise<string[]> {
    const paths = new Set<string>();
    for (const entry of await this.replay()) {
      paths.add(this.normalizeJournalPath(entry.filePath));
    }
    return [...paths].sort();
  }

  async truncate(): Promise<void> {
    await fs.mkdir(path.dirname(this.journalPath), { recursive: true });
    await fs.writeFile(this.journalPath, "", "utf8");
  }

  private normalizeJournalPath(filePath: string): string {
    if (this.repoRoot && path.isAbsolute(filePath)) return normalizeRepoPath(this.repoRoot, path.resolve(filePath));
    return normalizeUserPath(filePath);
  }
}

function parseEntry(line: string): WatchEventJournalEntry | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const candidate = parsed as Record<string, unknown>;
    if (!isWatchEvent(candidate.event)) return undefined;
    if (typeof candidate.filePath !== "string" || !candidate.filePath.trim()) return undefined;
    return {
      event: candidate.event,
      filePath: normalizeUserPath(candidate.filePath),
      observedAtMs: typeof candidate.observedAtMs === "number" ? candidate.observedAtMs : Date.now()
    };
  } catch {
    return undefined;
  }
}

function isWatchEvent(value: unknown): value is WatchEventJournalEntry["event"] {
  return value === "add" || value === "change" || value === "unlink" || value === "addDir" || value === "unlinkDir";
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
