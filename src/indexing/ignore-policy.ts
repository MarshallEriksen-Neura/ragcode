import type { FileClassification, SkippedFile } from "../core/types.js";

const IGNORED_DIRECTORY_ROLES = new Map<string, FileClassification>([
  [".git", { role: "vendor", reason: "git metadata" }],
  [".ragcode", { role: "build", reason: "RagCode index data" }],
  [".codegraph", { role: "build", reason: "CodeGraph index data" }],
  [".understand-anything", { role: "build", reason: "Understand Anything index data" }],
  [".omx", { role: "build", reason: "OMX runtime state" }],
  ["node_modules", { role: "vendor", reason: "Node dependency directory" }],
  [".venv", { role: "vendor", reason: "Python virtual environment" }],
  ["venv", { role: "vendor", reason: "Python virtual environment" }],
  ["env", { role: "vendor", reason: "Python virtual environment" }],
  ["site-packages", { role: "vendor", reason: "Python installed packages" }],
  ["__pycache__", { role: "build", reason: "Python bytecode cache" }],
  [".mypy_cache", { role: "build", reason: "Python type-check cache" }],
  [".pytest_cache", { role: "build", reason: "pytest cache" }],
  [".ruff_cache", { role: "build", reason: "Ruff cache" }],
  [".tox", { role: "vendor", reason: "tox environments" }],
  [".eggs", { role: "vendor", reason: "Python egg dependencies" }],
  ["vendor", { role: "vendor", reason: "vendored dependency directory" }],
  ["generated", { role: "generated", reason: "generated source directory" }],
  ["__generated__", { role: "generated", reason: "generated source directory" }],
  ["generated-sources", { role: "generated", reason: "generated source directory" }],
  ["dist", { role: "build", reason: "build output" }],
  ["build", { role: "build", reason: "build output" }],
  ["coverage", { role: "build", reason: "coverage output" }],
  ["target", { role: "build", reason: "Rust/JVM build output" }],
  ["out", { role: "build", reason: "build output" }],
  [".next", { role: "build", reason: "Next.js build output" }],
  [".turbo", { role: "build", reason: "Turborepo cache" }],
  [".gradle", { role: "build", reason: "Gradle cache" }],
  [".idea", { role: "config", reason: "IDE metadata" }],
  ["storybook-static", { role: "build", reason: "Storybook build output" }]
]);

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".ragcode",
  ".codegraph",
  ".understand-anything",
  ".omx",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  "site-packages",
  "dist",
  "build",
  "coverage",
  "target",
  ".next",
  ".turbo"
]);

const GENERATED_FILE_PATTERNS = [
  /(^|[\/])generated([\/]|$)/i,
  /(^|[\/])generated-sources([\/]|$)/i,
  /(^|[\/])__generated__([\/]|$)/i,
  /(^|[\/])gen([\/]|$)/i,
  /\.generated\.[^.]+$/i,
  /\.pb\.(go|rs|java|ts|js)$/i,
  /_pb2(_grpc)?\.py$/i,
  /(^|[\/])mockgen([\/]|$)/i,
  /(^|[\/])mocks?([\/]|$)/i,
  /\.mock\.[^.]+$/i
];

const MINIFIED_FILE_PATTERNS = [
  /\.min\.(js|css)$/i,
  /(^|[\/])_next[\/]static[\/]chunks[\/].+\.js$/i,
  /(^|[\/])static[\/]chunks[\/].+\.js$/i,
  /(^|[\/])assets[\/].+\.[a-f0-9]{8,}\.(js|css)$/i
];

const SENSITIVE_FILE_PATTERNS = [
  /^\.env(\..*)?$/i,
  /(^|[\\/])id_rsa$/i,
  /(^|[\\/])id_dsa$/i,
  /(^|[\\/])credentials?(\..*)?$/i,
  /(^|[\\/])secrets?(\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i
];

export interface IgnoreDecision {
  ignored: boolean;
  reason?: string;
  classification?: FileClassification;
}

export function shouldIgnoreDirectory(name: string): IgnoreDecision {
  const classification = IGNORED_DIRECTORY_ROLES.get(name);
  if (classification) return { ignored: true, reason: `ignored directory: ${name}`, classification };
  if (DEFAULT_IGNORED_DIRS.has(name)) return { ignored: true, reason: `ignored directory: ${name}`, classification: { role: "build", reason: "ignored directory" } };
  return { ignored: false };
}

export function shouldIgnoreFile(relativePath: string, maxFileBytes: number, sizeBytes: number): IgnoreDecision {
  const normalized = relativePath.replaceAll("\\", "/");
  const basename = normalized.split("/").pop() ?? normalized;
  if (SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(basename) || pattern.test(normalized))) {
    return { ignored: true, reason: "sensitive file policy", classification: { role: "config", reason: "sensitive file" } };
  }
  const classification = classifyRepoFile(normalized);
  if (classification.role === "generated" || classification.role === "minified" || classification.role === "build" || classification.role === "vendor") {
    return { ignored: true, reason: `${classification.role} file policy`, classification };
  }
  if (sizeBytes > maxFileBytes) return { ignored: true, reason: `file exceeds ${maxFileBytes} bytes`, classification };
  return { ignored: false };
}

export function classifyRepoFile(relativePath: string): FileClassification {
  const normalized = relativePath.replaceAll("\\", "/");
  const basename = normalized.split("/").pop() ?? normalized;
  const segments = normalized.split("/");

  for (const segment of segments.slice(0, -1)) {
    const directoryClassification = IGNORED_DIRECTORY_ROLES.get(segment);
    if (directoryClassification) return directoryClassification;
  }
  if (MINIFIED_FILE_PATTERNS.some((pattern) => pattern.test(normalized))) return { role: "minified", reason: "minified or bundled asset" };
  if (GENERATED_FILE_PATTERNS.some((pattern) => pattern.test(normalized))) return { role: "generated", reason: "generated source artifact" };
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(basename) || /(^|\/)(__tests__|tests?)(\/|$)/i.test(normalized)) return { role: "test", reason: "test file" };
  if (/\.(md|mdx)$/i.test(basename)) return { role: "docs", reason: "documentation file" };
  if (/^(package(-lock)?|pnpm-lock|yarn.lock|bun.lock|tsconfig|vite.config|vitest.config|next.config|tailwind.config|Cargo|go.mod|go.sum|pom|build.gradle|settings.gradle)(\.|$)/i.test(basename)) return { role: "config", reason: "project configuration" };
  if (/\.(json|toml|ya?ml|ini)$/i.test(basename)) return { role: "config", reason: "configuration file" };
  return { role: "source", reason: "source file" };
}

export function skippedFile(filePath: string, decision: IgnoreDecision): SkippedFile {
  return {
    filePath,
    reason: decision.reason ?? "ignored file",
    classification: decision.classification
  };
}
