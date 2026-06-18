import fs from "node:fs";
import path from "node:path";
import type { FileClassification } from "../core/types.js";

export interface GitIgnoreDecision {
  ignored: boolean;
  reason?: string;
  classification?: FileClassification;
}

interface GitIgnoreRule {
  raw: string;
  negated: boolean;
  directoryOnly: boolean;
  hasSlash: boolean;
  pathRegex?: RegExp;
  segmentRegex?: RegExp;
}

export interface GitIgnoreMatcher {
  match(relativePath: string, isDirectory?: boolean): GitIgnoreDecision;
}

const EMPTY_MATCHER: GitIgnoreMatcher = {
  match: () => ({ ignored: false })
};

export function loadGitIgnoreMatcher(repoRoot: string): GitIgnoreMatcher {
  const gitignorePath = path.join(path.resolve(repoRoot), ".gitignore");
  let contents: string;
  try {
    contents = fs.readFileSync(gitignorePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_MATCHER;
    throw error;
  }

  const rules = parseGitIgnore(contents);
  if (rules.length === 0) return EMPTY_MATCHER;

  return {
    match(relativePath: string, isDirectory = false): GitIgnoreDecision {
      const normalized = normalizePath(relativePath);
      if (!normalized) return { ignored: false };

      let ignored = false;
      let matched: GitIgnoreRule | undefined;
      for (const rule of rules) {
        if (!ruleMatches(rule, normalized, isDirectory)) continue;
        ignored = !rule.negated;
        matched = rule;
      }

      return ignored
        ? {
          ignored: true,
          reason: `gitignore pattern: ${matched?.raw ?? normalized}`,
          classification: { role: "build", reason: "gitignored path" }
        }
        : { ignored: false };
    }
  };
}

function parseGitIgnore(contents: string): GitIgnoreRule[] {
  const rules: GitIgnoreRule[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const parsed = parseGitIgnoreLine(rawLine);
    if (!parsed) continue;
    rules.push(parsed);
  }
  return rules;
}

function parseGitIgnoreLine(rawLine: string): GitIgnoreRule | undefined {
  let line = rawLine.trimEnd();
  if (!line) return undefined;
  if (line.startsWith("#")) return undefined;
  if (line.startsWith("\\#")) line = line.slice(1);

  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  } else if (line.startsWith("\\!")) {
    line = line.slice(1);
  }

  line = line.trim();
  if (!line) return undefined;

  const raw = line;
  const directoryOnly = line.endsWith("/");
  line = line.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!line) return undefined;

  const hasSlash = line.includes("/");
  return {
    raw,
    negated,
    directoryOnly,
    hasSlash,
    pathRegex: hasSlash ? pathRuleRegex(line, directoryOnly) : undefined,
    segmentRegex: !hasSlash ? segmentRuleRegex(line) : undefined
  };
}

function ruleMatches(rule: GitIgnoreRule, relativePath: string, isDirectory: boolean): boolean {
  if (rule.hasSlash) {
    return Boolean(rule.pathRegex?.test(relativePath));
  }

  if (rule.directoryOnly) {
    return relativePath
      .split("/")
      .some((segment) => Boolean(rule.segmentRegex?.test(segment)));
  }

  return relativePath.split("/").some((segment) => Boolean(rule.segmentRegex?.test(segment)));
}

function pathRuleRegex(pattern: string, directoryOnly: boolean): RegExp {
  const source = globToRegexSource(pattern);
  return new RegExp(directoryOnly ? `^${source}(?:/.*)?$` : `^${source}$`);
}

function segmentRuleRegex(pattern: string): RegExp {
  return new RegExp(`^${globToRegexSource(pattern)}$`);
}

function globToRegexSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") index += 1;
        if (pattern[index + 1] === "/") {
          source += "(?:.*/)?";
          index += 1;
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegex(char);
  }
  return source;
}

function escapeRegex(char: string): string {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

function normalizePath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
}
