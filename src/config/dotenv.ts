import fs from "node:fs";
import path from "node:path";

export function loadDotEnv(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const filePath = path.join(cwd, ".env");
  if (!fs.existsSync(filePath)) return env;

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

function parseEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;

  const separator = trimmed.indexOf("=");
  if (separator <= 0) return undefined;

  const key = trimmed.slice(0, separator).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined;

  const rawValue = trimmed.slice(separator + 1).trim();
  return [key, unquoteValue(rawValue)];
}

function unquoteValue(value: string): string {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
      return value.slice(1, -1);
    }
  }
  return value;
}
