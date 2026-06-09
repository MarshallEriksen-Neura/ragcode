import Parser from "tree-sitter";
// @ts-ignore - tree-sitter-java doesn't have TypeScript definitions
import Java from "tree-sitter-java";
import type { AnalyzeFileInput, FileAnalysis, LanguageAnalyzer } from "./types.js";
import { analyzeWithTreeSitter, type TreeSitterLanguageConfig } from "./tree-sitter-base.js";

let parser: Parser | null = null;

function getParser(): Parser {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Java);
  }
  return parser;
}

const javaConfig: TreeSitterLanguageConfig = {
  symbolPatterns: [
    {
      type: "class_declaration",
      kind: "class",
      nameField: "name",
      exportModifierCheck: (node) => {
        return node.children.some((child) => child.type === "modifiers" && child.text.includes("public"));
      }
    },
    {
      type: "interface_declaration",
      kind: "type",
      nameField: "name",
      exportModifierCheck: (node) => {
        return node.children.some((child) => child.type === "modifiers" && child.text.includes("public"));
      }
    },
    {
      type: "enum_declaration",
      kind: "type",
      nameField: "name",
      exportModifierCheck: (node) => {
        return node.children.some((child) => child.type === "modifiers" && child.text.includes("public"));
      }
    },
    {
      type: "method_declaration",
      kind: "method",
      nameField: "name",
      exportModifierCheck: (node) => {
        return node.children.some((child) => child.type === "modifiers" && child.text.includes("public"));
      }
    },
    {
      type: "constructor_declaration",
      kind: "method",
      nameField: "name",
      exportModifierCheck: (node) => {
        return node.children.some((child) => child.type === "modifiers" && child.text.includes("public"));
      }
    }
  ],
  importPatterns: [
    {
      type: "import_declaration",
      sourceExtractor: javaImportName,
      bindingsExtractor: (node) => {
        const fullPath = javaImportName(node);
        if (!fullPath) return [];

        const className = fullPath.split(".").pop() ?? fullPath;

        return [{ imported: fullPath, local: className }];
      }
    }
  ],
  callPatterns: [
    {
      type: "method_invocation",
      nameExtractor: (node) => {
        const nameNode = node.childForFieldName("name");
        return nameNode?.text;
      }
    }
  ]
};

export const javaTreeSitterAnalyzer: LanguageAnalyzer = {
  language: "java",
  capabilities: ["symbols", "imports", "exports", "calls"],
  analyzeFile: ({ repoRoot, file, content }: AnalyzeFileInput): FileAnalysis => {
    return analyzeWithTreeSitter(getParser(), javaConfig, repoRoot, file, content);
  }
};

function javaImportName(node: Parser.SyntaxNode): string | undefined {
  return node.children.find((child) => child.type === "scoped_identifier" || child.type === "identifier")?.text;
}
