export type EvidencePathKind = "implementation" | "test" | "docs" | "fixture";

export function classifyEvidencePath(filePath: string): EvidencePathKind {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  if (isTestPath(normalized)) return "test";
  if (/(^|\/)(__fixtures__|fixtures?|playground|examples?|samples?|demo)(\/|$)/.test(normalized)) return "fixture";
  if (/(^|\/)(docs?|documentation)(\/|$)|\.mdx?$/.test(normalized)) return "docs";
  return "implementation";
}

export function isSupportingEvidencePath(filePath: string): boolean {
  return classifyEvidencePath(filePath) !== "implementation";
}

export function isExplicitSupportingEvidenceQuery(query: string): boolean {
  return /\b(test|tests|spec|coverage|regression|doc|docs|documentation|readme|example|examples|sample|samples|fixture|fixtures|playground|demo)\b/i.test(query);
}

export function isExplicitTestQuery(query: string): boolean {
  return /\b(test|tests|spec|coverage|regression)\b/i.test(query);
}

export function isTestPath(filePath: string): boolean {
  return /(^|\/)(__tests__|tests?)(\/|$)|\.(test|spec)\.[jt]sx?$/.test(filePath.replaceAll("\\", "/").toLowerCase());
}
