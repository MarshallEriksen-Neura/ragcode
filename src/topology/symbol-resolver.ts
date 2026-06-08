import type { CodeFile, GraphEdge, SymbolNode } from "../core/types.js";
import { createExportIndex, exportKey } from "./export-index.js";
import { resolveImportPath } from "./import-resolver.js";

export interface ImportBinding {
  imported: string;
  local: string;
}

interface ResolvedImportBinding extends ImportBinding {
  targetFile: string;
}

export function resolveGraphEdges(files: CodeFile[], symbols: SymbolNode[], edges: GraphEdge[]): GraphEdge[] {
  const exportIndex = createExportIndex(symbols);
  const bindingsByFile = new Map<string, Map<string, ResolvedImportBinding>>();
  const resolvedEdges: GraphEdge[] = [];

  for (const edge of edges) {
    if (edge.kind !== "imports") {
      resolvedEdges.push(edge);
      continue;
    }

    const sourceFile = stringMetadata(edge, "sourceFile");
    const importSource = stringMetadata(edge, "source");
    const targetFile = sourceFile && importSource ? resolveImportPath(sourceFile, importSource, files) : undefined;
    if (!sourceFile || !targetFile) {
      resolvedEdges.push({ ...edge, metadata: { ...edge.metadata, resolution: "unresolved" } });
      continue;
    }

    const fileSymbol = exportIndex.fileSymbols.get(targetFile);
    resolvedEdges.push({
      ...edge,
      targetId: fileSymbol?.id ?? edge.targetId,
      metadata: { ...edge.metadata, resolution: "resolved", targetFile }
    });

    const bindings = importBindings(edge);
    if (bindings.length === 0) continue;
    const fileBindings = bindingsByFile.get(sourceFile) ?? new Map<string, ResolvedImportBinding>();
    for (const binding of bindings) {
      fileBindings.set(binding.local, { ...binding, targetFile });
    }
    bindingsByFile.set(sourceFile, fileBindings);
  }

  return resolvedEdges.map((edge) => {
    if (edge.kind !== "calls") return edge;
    const sourceFile = stringMetadata(edge, "sourceFile");
    const targetName = stringMetadata(edge, "targetName");
    if (!sourceFile || !targetName) return edge;

    const binding = bindingsByFile.get(sourceFile)?.get(targetName);
    if (!binding) return { ...edge, metadata: { ...edge.metadata, resolution: "unresolved" } };

    const targetSymbol = exportIndex.exportedSymbols.get(exportKey(binding.targetFile, binding.imported));
    if (!targetSymbol) return { ...edge, metadata: { ...edge.metadata, resolution: "unresolved", targetFile: binding.targetFile } };

    return {
      ...edge,
      targetId: targetSymbol.id,
      metadata: {
        ...edge.metadata,
        resolution: "resolved",
        targetFile: targetSymbol.filePath,
        importedName: binding.imported
      }
    };
  });
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
