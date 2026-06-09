import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

export function loadDotEnv(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const filePath = path.join(cwd, ".env");
  if (!fs.existsSync(filePath)) return env;

  const parsed = parseEnv(fs.readFileSync(filePath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}
