import type { GraphEdge, SymbolNode } from "../core/types.js";
import { createExportIndex, exportKey } from "./export-index.js";

interface ImportBinding {
  imported: string;
  local: string;
}

export function buildTestTopologyEdges(symbols: SymbolNode[], edges: GraphEdge[]): GraphEdge[] {
  const exportIndex = createExportIndex(symbols);
  const testEdges: GraphEdge[] = [];

  for (const edge of edges) {
    if (edge.kind !== "imports") continue;
    const testFile = stringMetadata(edge, "sourceFile");
    const sourceFile = stringMetadata(edge, "targetFile");
    if (!testFile || !sourceFile || !isTestFile(testFile) || isTestFile(sourceFile)) continue;

    const testFileSymbol = exportIndex.fileSymbols.get(testFile);
    if (!testFileSymbol) continue;

    const bindings = importBindings(edge);
    const sourceSymbols = bindings.length > 0
      ? bindings.map((binding) => ({
          symbol: binding.imported === "default"
            ? undefined
            : exportIndex.exportedSymbols.get(exportKey(sourceFile, binding.imported)),
          binding
        }))
      : [{ symbol: undefined, binding: undefined }];

    for (const entry of sourceSymbols) {
      const sourceSymbol = entry.symbol ?? exportIndex.fileSymbols.get(sourceFile);
      if (!sourceSymbol) continue;
      testEdges.push({
        projectId: edge.projectId,
        sourceId: sourceSymbol.id,
        targetId: testFileSymbol.id,
        kind: "tested_by",
        metadata: {
          sourceFile,
          targetFile: testFile,
          testFile,
          targetName: testFile,
          importedName: entry.binding?.imported,
          localName: entry.binding?.local,
          line: edge.metadata?.line,
          resolution: "test_import",
          colocated: sameDirectory(sourceFile, testFile)
        }
      });
    }
  }

  return dedupeEdges(testEdges);
}

function importBindings(edge: GraphEdge): ImportBinding[] {
  const raw = edge.metadata?.bindings;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isImportBinding);
}

function isImportBinding(value: unknown): value is ImportBinding {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.imported === "string" && typeof candidate.local === "string";
}

function stringMetadata(edge: GraphEdge, key: string): string | undefined {
  const value = edge.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function isTestFile(filePath: string): boolean {
  return /(^|\/)(__tests__|tests?)(\/|$)|\.(test|spec)\.[jt]sx?$/.test(filePath);
}

function sameDirectory(left: string, right: string): boolean {
  return left.split("/").slice(0, -1).join("/") === right.split("/").slice(0, -1).join("/");
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  const deduped: GraphEdge[] = [];
  for (const edge of edges) {
    const key = [edge.kind, edge.sourceId, edge.targetId, edge.metadata?.importedName].join("::");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(edge);
  }
  return deduped;
}
