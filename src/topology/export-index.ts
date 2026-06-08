import type { SymbolNode } from "../core/types.js";

export interface ExportIndex {
  fileSymbols: Map<string, SymbolNode>;
  exportedSymbols: Map<string, SymbolNode>;
}

export function createExportIndex(symbols: SymbolNode[]): ExportIndex {
  const fileSymbols = new Map<string, SymbolNode>();
  const exportedSymbols = new Map<string, SymbolNode>();

  for (const symbol of symbols) {
    if (symbol.kind === "file") fileSymbols.set(symbol.filePath, symbol);
    if (symbol.exported) exportedSymbols.set(exportKey(symbol.filePath, symbol.name), symbol);
  }

  return { fileSymbols, exportedSymbols };
}

export function exportKey(filePath: string, name: string): string {
  return `${filePath}::${name}`;
}
