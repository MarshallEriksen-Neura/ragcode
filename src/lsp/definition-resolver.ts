import type { GraphEdge, SymbolNode } from "../core/types.js";
import { TypeScriptLanguageService, type TypeScriptDefinitionLocation, type TypeScriptSourceFile } from "./typescript-language-service.js";

export interface TypeScriptDefinitionResolverOptions {
  createService?: (repoRoot: string, sources: TypeScriptSourceFile[]) => Pick<TypeScriptLanguageService, "getDefinitionAt">;
}

export function resolveCallDefinitionsWithTypeScript(
  repoRoot: string,
  sources: TypeScriptSourceFile[],
  symbols: SymbolNode[],
  edges: GraphEdge[],
  options: TypeScriptDefinitionResolverOptions = {}
): GraphEdge[] {
  if (sources.length === 0) return edges;

  try {
    const service = options.createService?.(repoRoot, sources) ?? new TypeScriptLanguageService(repoRoot, sources);
    return edges.map((edge) => resolveCallEdge(service, symbols, edge));
  } catch {
    return edges;
  }
}

function resolveCallEdge(service: Pick<TypeScriptLanguageService, "getDefinitionAt">, symbols: SymbolNode[], edge: GraphEdge): GraphEdge {
  if (edge.kind !== "calls" || edge.metadata?.resolution === "resolved") return edge;

  const sourceFile = stringMetadata(edge, "sourceFile");
  const position = numberMetadata(edge, "position");
  if (!sourceFile || position === undefined) return unresolved(edge);

  const definitions = service.getDefinitionAt(sourceFile, position);
  const targetSymbol = findTargetSymbol(symbols, definitions, stringMetadata(edge, "targetName"));
  if (!targetSymbol) return unresolved(edge);

  return {
    ...edge,
    targetId: targetSymbol.id,
    metadata: {
      ...edge.metadata,
      resolution: "resolved_lsp",
      targetFile: targetSymbol.filePath,
      targetSymbol: targetSymbol.name
    }
  };
}

function findTargetSymbol(symbols: SymbolNode[], definitions: TypeScriptDefinitionLocation[], targetName?: string): SymbolNode | undefined {
  const candidates = definitions.flatMap((definition) => {
    const containing = symbols.filter((symbol) =>
      symbol.kind !== "file" &&
      symbol.filePath === definition.filePath &&
      symbol.startLine <= definition.startLine &&
      symbol.endLine >= definition.startLine
    );
    return containing.map((symbol) => ({ symbol, definition }));
  });

  return candidates.find(({ symbol }) => targetName && symbol.name === targetName)?.symbol
    ?? candidates.find(({ symbol, definition }) => definition.name && symbol.name === definition.name)?.symbol
    ?? candidates.sort((a, b) => symbolSpan(a.symbol) - symbolSpan(b.symbol))[0]?.symbol;
}

function unresolved(edge: GraphEdge): GraphEdge {
  return { ...edge, metadata: { ...edge.metadata, resolution: "unresolved" } };
}

function symbolSpan(symbol: SymbolNode): number {
  return symbol.endLine - symbol.startLine;
}

function stringMetadata(edge: GraphEdge, key: string): string | undefined {
  const value = edge.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberMetadata(edge: GraphEdge, key: string): number | undefined {
  const value = edge.metadata?.[key];
  return typeof value === "number" ? value : undefined;
}
