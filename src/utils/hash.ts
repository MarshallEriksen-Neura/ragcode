import { createHash } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function stableId(parts: Array<string | number | undefined>): string {
  return sha256(parts.filter((part) => part !== undefined).join("::")).slice(0, 24);
}
