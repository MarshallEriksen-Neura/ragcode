import path from "node:path";
import ts from "typescript";
import { normalizeRepoPath } from "../utils/path.js";

export interface TypeScriptSourceFile {
  filePath: string;
  absolutePath: string;
  content: string;
}

export interface TypeScriptDefinitionLocation {
  filePath: string;
  startLine: number;
  endLine: number;
  name?: string;
}

export class TypeScriptLanguageService {
  private readonly service: ts.LanguageService;
  private readonly absoluteByRepoPath = new Map<string, string>();
  private readonly contentByAbsolutePath = new Map<string, string>();

  constructor(private readonly repoRoot: string, sources: TypeScriptSourceFile[]) {
    for (const source of sources) {
      const absolutePath = normalizeAbsolutePath(source.absolutePath);
      this.absoluteByRepoPath.set(source.filePath, absolutePath);
      this.contentByAbsolutePath.set(absolutePath, source.content);
    }

    this.service = ts.createLanguageService(this.createHost());
  }

  getDefinitionAt(repoFilePath: string, position: number): TypeScriptDefinitionLocation[] {
    const absolutePath = this.absoluteByRepoPath.get(repoFilePath);
    if (!absolutePath) return [];
    const definitions = this.service.getDefinitionAtPosition(absolutePath, position) ?? [];
    return definitions
      .map((definition) => this.toDefinitionLocation(definition))
      .filter((definition): definition is TypeScriptDefinitionLocation => Boolean(definition));
  }

  private createHost(): ts.LanguageServiceHost {
    return {
      getCompilationSettings: () => ({
        allowJs: true,
        checkJs: false,
        esModuleInterop: true,
        jsx: ts.JsxEmit.Preserve,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022
      }),
      getCurrentDirectory: () => this.repoRoot,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      getScriptFileNames: () => [...this.contentByAbsolutePath.keys()],
      getScriptVersion: () => "1",
      getScriptSnapshot: (fileName) => {
        const normalized = normalizeAbsolutePath(fileName);
        const content = this.contentByAbsolutePath.get(normalized) ?? ts.sys.readFile(normalized);
        return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
      },
      fileExists: (fileName) => this.contentByAbsolutePath.has(normalizeAbsolutePath(fileName)) || ts.sys.fileExists(fileName),
      readFile: (fileName) => this.contentByAbsolutePath.get(normalizeAbsolutePath(fileName)) ?? ts.sys.readFile(fileName),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories
    };
  }

  private toDefinitionLocation(definition: ts.DefinitionInfo): TypeScriptDefinitionLocation | undefined {
    const absolutePath = normalizeAbsolutePath(definition.fileName);
    const content = this.contentByAbsolutePath.get(absolutePath);
    if (!content) return undefined;
    const start = lineAt(content, definition.textSpan.start);
    const end = lineAt(content, definition.textSpan.start + definition.textSpan.length);
    return {
      filePath: normalizeRepoPath(this.repoRoot, absolutePath),
      startLine: start,
      endLine: end,
      name: definition.name
    };
  }
}

function normalizeAbsolutePath(filePath: string): string {
  return path.resolve(filePath);
}

function lineAt(content: string, position: number): number {
  const safePosition = Math.max(0, Math.min(position, content.length));
  let line = 1;
  for (let index = 0; index < safePosition; index += 1) {
    if (content.charCodeAt(index) === 10) line += 1;
  }
  return line;
}
