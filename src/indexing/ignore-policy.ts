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
}

export function shouldIgnoreDirectory(name: string): IgnoreDecision {
  if (DEFAULT_IGNORED_DIRS.has(name)) return { ignored: true, reason: `ignored directory: ${name}` };
  return { ignored: false };
}

export function shouldIgnoreFile(relativePath: string, maxFileBytes: number, sizeBytes: number): IgnoreDecision {
  const normalized = relativePath.replaceAll("\\", "/");
  const basename = normalized.split("/").pop() ?? normalized;
  if (SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(basename) || pattern.test(normalized))) {
    return { ignored: true, reason: "sensitive file policy" };
  }
  if (sizeBytes > maxFileBytes) return { ignored: true, reason: `file exceeds ${maxFileBytes} bytes` };
  return { ignored: false };
}
