import ts from "typescript";
import type { CodeChunk } from "../core/types.js";

export function skeletonizeChunk(chunk: CodeChunk): string {
  if (chunk.language !== "typescript" && chunk.language !== "javascript") return genericSkeleton(chunk.content);

  const sourceFile = ts.createSourceFile(chunk.filePath, chunk.content, ts.ScriptTarget.Latest, true, scriptKindForPath(chunk.filePath));
  const declarations: string[] = [];

  for (const statement of sourceFile.statements) {
    const rendered = renderDeclaration(sourceFile, statement);
    if (rendered) declarations.push(rendered);
  }

  if (declarations.length === 0 && chunk.symbolName) return `${chunk.kind} ${chunk.symbolName} { ... }`;
  return declarations.length > 0 ? declarations.join("\n\n") : genericSkeleton(chunk.content);
}

function renderDeclaration(sourceFile: ts.SourceFile, node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return firstLine(sourceFile, node);
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return sourceText(sourceFile, node);
  if (ts.isFunctionDeclaration(node)) return `${leadingComment(sourceFile, node)}${functionSignature(sourceFile, node)} { ... }`.trim();
  if (ts.isClassDeclaration(node)) return renderClass(sourceFile, node);
  if (ts.isVariableStatement(node)) return `${leadingComment(sourceFile, node)}${firstLine(sourceFile, node).replace(/=\s*.+;?$/, "= ...;")}`.trim();
  return undefined;
}

function renderClass(sourceFile: ts.SourceFile, node: ts.ClassDeclaration): string {
  const name = node.name?.text ?? "AnonymousClass";
  const heritage = node.heritageClauses?.map((clause) => sourceText(sourceFile, clause)).join(" ") ?? "";
  const members = node.members
    .map((member) => renderClassMember(sourceFile, member))
    .filter(Boolean)
    .map((member) => `  ${member}`)
    .join("\n");
  return `${leadingComment(sourceFile, node)}class ${name}${heritage ? ` ${heritage}` : ""} {\n${members}\n}`.trim();
}

function renderClassMember(sourceFile: ts.SourceFile, member: ts.ClassElement): string | undefined {
  if (ts.isConstructorDeclaration(member)) return `${firstLine(sourceFile, member).replace(/\{\s*$/, "").trim()} { ... }`;
  if (ts.isMethodDeclaration(member)) return `${firstLine(sourceFile, member).replace(/\{\s*$/, "").trim()} { ... }`;
  if (ts.isPropertyDeclaration(member)) return firstLine(sourceFile, member).replace(/=\s*.+;?$/, "= ...;");
  return undefined;
}

function functionSignature(sourceFile: ts.SourceFile, node: ts.FunctionDeclaration): string {
  const text = sourceText(sourceFile, node);
  const bodyStart = text.indexOf("{");
  return (bodyStart >= 0 ? text.slice(0, bodyStart) : text).trim();
}

function genericSkeleton(content: string): string {
  const first = content.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "[empty chunk]";
  return `${first}\n...`;
}

function leadingComment(sourceFile: ts.SourceFile, node: ts.Node): string {
  const comments = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? [];
  const rendered = comments
    .map((comment) => sourceFile.text.slice(comment.pos, comment.end).trim())
    .filter((comment) => comment.startsWith("/**"))
    .join("\n");
  return rendered ? `${rendered}\n` : "";
}

function firstLine(sourceFile: ts.SourceFile, node: ts.Node): string {
  return sourceText(sourceFile, node).split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function sourceText(sourceFile: ts.SourceFile, node: ts.Node): string {
  return sourceFile.text.slice(node.getStart(sourceFile), node.getEnd()).trim();
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
