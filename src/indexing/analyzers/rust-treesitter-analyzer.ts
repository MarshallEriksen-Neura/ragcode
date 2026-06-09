import Parser from "tree-sitter";
// @ts-ignore - tree-sitter-rust doesn't have TypeScript definitions
import Rust from "tree-sitter-rust";
import type { AnalyzeFileInput, FileAnalysis, LanguageAnalyzer } from "./types.js";
import { analyzeWithTreeSitter, type TreeSitterLanguageConfig } from "./tree-sitter-base.js";

let parser: Parser | null = null;

function getParser(): Parser {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Rust);
  }
  return parser;
}

const rustConfig: TreeSitterLanguageConfig = {
  symbolPatterns: [
    {
      type: "function_item",
      kind: "function",
      nameField: "name",
      exportModifierCheck: (node) => {
        return node.children.some((child) => child.type === "visibility_modifier" && child.text === "pub");
      }
    },
    {
      type: "struct_item",
      kind: "type",
      nameField: "name",
      exportModifierCheck: (node) => {
        return node.children.some((child) => child.type === "visibility_modifier" && child.text === "pub");
      }
    },
    {
      type: "enum_item",
      kind: "type",
      nameField: "name",
      exportModifierCheck: (node) => {
        return node.children.some((child) => child.type === "visibility_modifier" && child.text === "pub");
      }
    },
    {
      type: "trait_item",
      kind: "type",
      nameField: "name",
      exportModifierCheck: (node) => {
        return node.children.some((child) => child.type === "visibility_modifier" && child.text === "pub");
      }
    },
    {
      type: "impl_item",
      kind: "type",
      nameField: "type",
      exportModifierCheck: () => false // impl blocks are internal implementation details
    }
  ],
  importPatterns: [
    {
      type: "use_declaration",
      sourceField: "argument",
      bindingsExtractor: (node) => {
        const argNode = node.childForFieldName("argument");
        if (!argNode) return [];

        const path = argNode.text;
        return [{ imported: path, local: path.split("::").pop() ?? path }];
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
        } else if (functionNode.type === "field_expression") {
          const fieldNode = functionNode.childForFieldName("field");
          return fieldNode?.text;
        } else if (functionNode.type === "scoped_identifier") {
          const nameNode = functionNode.childForFieldName("name");
          return nameNode?.text;
        }

        return undefined;
      }
    }
  ]
};

export const rustTreeSitterAnalyzer: LanguageAnalyzer = {
  language: "rust",
  capabilities: ["symbols", "imports", "exports", "calls"],
  analyzeFile: ({ repoRoot, file, content }: AnalyzeFileInput): FileAnalysis => {
    return analyzeWithTreeSitter(getParser(), rustConfig, repoRoot, file, content);
  }
};
