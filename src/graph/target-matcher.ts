import type { GraphEdge, SymbolNode } from "../core/types.js";
import { normalizeUserPath } from "../utils/path.js";

export interface ImpactTargetSpec {
  raw: string;
  normalized: string;
  lowered: string;
  filePath?: string;
  symbolName?: string;
  qualified: boolean;
}

export function parseImpactTarget(target: string): ImpactTargetSpec {
  const normalized = normalizeUserPath(target.trim());
  const qualified = parseQualifiedTarget(normalized);
  if (qualified) {
    return {
      raw: target,
      normalized,
      lowered: normalized.toLowerCase(),
      filePath: qualified.filePath,
      symbolName: qualified.symbolName,
      qualified: true
    };
  }
  return {
    raw: target,
    normalized,
    lowered: target.toLowerCase(),
    qualified: false
  };
}

export function matchesImpactTarget(symbol: SymbolNode, target: ImpactTargetSpec): boolean {
  if (target.qualified) {
    return Boolean(
      target.filePath
      && target.symbolName
      && filePathMatches(symbol.filePath, target.filePath)
      && symbol.name === target.symbolName
    );
  }
  return symbol.name.toLowerCase().includes(target.lowered)
    || symbol.filePath === target.normalized
    || symbol.filePath.includes(target.normalized);
}

export function isIncomingImpactEdge(edge: GraphEdge, matchedIds: Set<string>, target: ImpactTargetSpec): boolean {
  if (matchedIds.has(edge.targetId)) return true;
  if (target.qualified) return false;
  return String(edge.metadata?.targetName ?? "").toLowerCase().includes(target.lowered);
}

export function isOutgoingImpactEdge(edge: GraphEdge, matchedIds: Set<string>, target: ImpactTargetSpec): boolean {
  if (matchedIds.has(edge.sourceId)) return true;
  const sourceFile = typeof edge.metadata?.sourceFile === "string" ? edge.metadata.sourceFile : undefined;
  if (!sourceFile) return false;
  const fileTarget = target.filePath ?? target.normalized;
  return target.symbolName ? false : filePathMatches(sourceFile, fileTarget);
}

function parseQualifiedTarget(target: string): { filePath: string; symbolName: string } | undefined {
  const separatorIndex = Math.max(target.lastIndexOf(":"), target.lastIndexOf("#"));
  if (separatorIndex <= 0 || separatorIndex === target.length - 1) return undefined;

  const filePath = target.slice(0, separatorIndex);
  const symbolName = target.slice(separatorIndex + 1);
  if (!looksLikePath(filePath) || !symbolName) return undefined;
  return { filePath, symbolName };
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || /\.[cm]?[jt]sx?$/.test(value) || /\.[a-z0-9]+$/i.test(value);
}

function filePathMatches(actual: string, expected: string): boolean {
  return actual === expected || actual.endsWith(`/${expected}`);
}
