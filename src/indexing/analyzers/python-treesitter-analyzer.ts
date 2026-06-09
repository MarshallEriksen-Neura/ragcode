import Parser from "tree-sitter";
// @ts-ignore - tree-sitter-python doesn't have TypeScript definitions
import Python from "tree-sitter-python";
import type { AnalyzeFileInput, FileAnalysis, LanguageAnalyzer } from "./types.js";
import { analyzeWithTreeSitter, type TreeSitterLanguageConfig } from "./tree-sitter-base.js";

let parser: Parser | null = null;

function getParser(): Parser {
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(Python);
  }
  return parser;
}

const pythonConfig: TreeSitterLanguageConfig = {
  symbolPatterns: [
    {
      type: "function_definition",
      kind: "function",
      nameField: "name",
      exportModifierCheck: (node) => {
        const name = node.childForFieldName("name")?.text;
        return name ? !name.startsWith("_") : false;
      }
    },
    {
      type: "class_definition",
      kind: "class",
      nameField: "name",
      exportModifierCheck: (node) => {
        const name = node.childForFieldName("name")?.text;
        return name ? !name.startsWith("_") : false;
      }
    }
  ],
  importPatterns: [
    {
      type: "import_statement",
      sourceField: "name",
      bindingsExtractor: (node) => {
        const name = node.childForFieldName("name");
        if (!name) return [];

        const moduleName = name.text;
        return [{ imported: moduleName, local: moduleName }];
      }
    },
    {
      type: "import_from_statement",
      sourceField: "module_name",
      bindingsExtractor: (node) => {
        const bindings: Array<{ imported: string; local: string }> = [];

        for (const child of node.children) {
          if (child.type === "dotted_name" || child.type === "identifier") {
            const name = child.text;
            bindings.push({ imported: name, local: name });
          } else if (child.type === "aliased_import") {
            const nameNode = child.childForFieldName("name");
            const aliasNode = child.childForFieldName("alias");
            if (nameNode) {
              bindings.push({
                imported: nameNode.text,
                local: aliasNode?.text ?? nameNode.text
              });
            }
          }
        }

        return bindings;
      }
    }
  ],
  callPatterns: [
    {
      type: "call",
      nameExtractor: (node) => {
        const functionNode = node.childForFieldName("function");
        if (!functionNode) return undefined;

        if (functionNode.type === "identifier") {
          return functionNode.text;
        } else if (functionNode.type === "attribute") {
          const attrNode = functionNode.childForFieldName("attribute");
          return attrNode?.text;
        }

        return undefined;
      }
    }
  ]
};

export const pythonTreeSitterAnalyzer: LanguageAnalyzer = {
  language: "python",
  capabilities: ["symbols", "imports", "exports", "calls"],
  analyzeFile: ({ repoRoot, file, content }: AnalyzeFileInput): FileAnalysis => {
    return analyzeWithTreeSitter(getParser(), pythonConfig, repoRoot, file, content);
  }
};
