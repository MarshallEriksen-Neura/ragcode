import Parser from "tree-sitter";
// @ts-ignore - tree-sitter-go doesn't have TypeScript definitions
import Go from "tree-sitter-go";
import type { AnalyzeFileInput, FileAnalysis, LanguageAnalyzer } from "./types.js";
import { analyzeWithTreeSitter, type TreeSitterLanguageConfig } from "./tree-sitter-base.js";

let parser: Parser | null = null;

function getParser(): Parser {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Go);
  }
  return parser;
}

const goConfig: TreeSitterLanguageConfig = {
  symbolPatterns: [
    {
      type: "function_declaration",
      kind: "function",
      nameField: "name",
      exportModifierCheck: (node) => {
        const name = node.childForFieldName("name")?.text;
        return name ? /^[A-Z]/.test(name) : false;
      }
    },
    {
      type: "method_declaration",
      kind: "method",
      nameField: "name",
      exportModifierCheck: (node) => {
        const name = node.childForFieldName("name")?.text;
        return name ? /^[A-Z]/.test(name) : false;
      }
    },
    {
      type: "type_declaration",
      kind: "type",
      nameExtractor: typeDeclarationName,
      exportModifierCheck: (node) => {
        const name = typeDeclarationName(node);
        return name ? /^[A-Z]/.test(name) : false;
      }
    }
  ],
  importPatterns: [
    {
      type: "import_spec",
      sourceField: "path",
      bindingsExtractor: (node) => {
        const pathNode = node.childForFieldName("path");
        if (!pathNode) return [];

        const path = pathNode.text.replace(/"/g, "");
        const nameNode = node.childForFieldName("name");
        const name = nameNode?.text ?? path.split("/").pop() ?? path;

        return [{ imported: path, local: name }];
      }
    }
  ],
  callPatterns: [
    {
      type: "call_expression",
      nameExtractor: (node) => {
        const functionNode = node.childForFieldName("function");
        if (!functionNode) return undefined;

        if (functionNode.type === "identifier") {
          return functionNode.text;
        } else if (functionNode.type === "selector_expression") {
          const fieldNode = functionNode.childForFieldName("field");
          return fieldNode?.text;
        }

        return undefined;
      }
    }
  ]
};

export const goTreeSitterAnalyzer: LanguageAnalyzer = {
  language: "go",
  capabilities: ["symbols", "imports", "exports", "calls", "tests"],
  analyzeFile: ({ repoRoot, file, content }: AnalyzeFileInput): FileAnalysis => {
    return analyzeWithTreeSitter(getParser(), goConfig, repoRoot, file, content);
  }
};

function typeDeclarationName(node: Parser.SyntaxNode): string | undefined {
  const specNode = node.children.find((child) => child.type === "type_spec");
  return specNode?.childForFieldName("name")?.text;
}
