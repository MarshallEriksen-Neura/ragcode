import { describe, it, expect } from "vitest";
import { pythonTreeSitterAnalyzer } from "../src/indexing/analyzers/python-treesitter-analyzer.js";
import type { CodeFile } from "../src/core/types.js";

describe("Python Tree-sitter Analyzer", () => {
  const testFile: CodeFile = {
    projectId: "test-project",
    path: "test.py",
    absolutePath: "/test/test.py",
    language: "python",
    sizeBytes: 0,
    contentHash: "test-hash",
    modifiedAtMs: Date.now()
  };

  it("should extract top-level functions", () => {
    const content = `
def public_function():
    return 42

def _private_function():
    return 0
`;

    const result = pythonTreeSitterAnalyzer.analyzeFile({
      repoRoot: "/test",
      file: testFile,
      content
    });

    const functions = result.symbols.filter((s) => s.kind === "function");
    expect(functions).toHaveLength(2);

    const publicFunc = functions.find((f) => f.name === "public_function");
    expect(publicFunc).toBeDefined();
    expect(publicFunc?.exported).toBe(true);

    const privateFunc = functions.find((f) => f.name === "_private_function");
    expect(privateFunc).toBeDefined();
    expect(privateFunc?.exported).toBe(false);
  });

  it("should extract classes", () => {
    const content = `
class PublicClass:
    def method(self):
        pass

class _PrivateClass:
    pass
`;

    const result = pythonTreeSitterAnalyzer.analyzeFile({
      repoRoot: "/test",
      file: testFile,
      content
    });

    const classes = result.symbols.filter((s) => s.kind === "class");
    expect(classes).toHaveLength(2);

    const publicClass = classes.find((c) => c.name === "PublicClass");
    expect(publicClass).toBeDefined();
    expect(publicClass?.exported).toBe(true);

    const privateClass = classes.find((c) => c.name === "_PrivateClass");
    expect(privateClass).toBeDefined();
    expect(privateClass?.exported).toBe(false);
  });

  it("should extract imports", () => {
    const content = `
import os
import sys
from pathlib import Path
from typing import List, Dict
`;

    const result = pythonTreeSitterAnalyzer.analyzeFile({
      repoRoot: "/test",
      file: testFile,
      content
    });

    const imports = result.edges.filter((e) => e.kind === "imports");
    expect(imports.length).toBeGreaterThanOrEqual(3);

    const osImport = imports.find((i) => i.metadata?.source === "os");
    expect(osImport).toBeDefined();

    const pathlibImport = imports.find((i) => i.metadata?.source === "pathlib");
    expect(pathlibImport).toBeDefined();
  });

  it("should extract function calls", () => {
    const content = `
def main():
    print("hello")
    calculate_sum(1, 2)
    obj.method()
`;

    const result = pythonTreeSitterAnalyzer.analyzeFile({
      repoRoot: "/test",
      file: testFile,
      content
    });

    const calls = result.edges.filter((e) => e.kind === "calls");
    expect(calls.length).toBeGreaterThanOrEqual(2);

    const printCall = calls.find((c) => c.metadata?.targetName === "print");
    expect(printCall).toBeDefined();

    const calcCall = calls.find((c) => c.metadata?.targetName === "calculate_sum");
    expect(calcCall).toBeDefined();

    const methodCall = calls.find((c) => c.metadata?.targetName === "method");
    expect(methodCall).toBeDefined();
  });

  it("should handle complex Python code with decorators", () => {
    const content = `
@decorator
def decorated_function():
    pass

class MyClass:
    @property
    def value(self):
        return self._value
`;

    const result = pythonTreeSitterAnalyzer.analyzeFile({
      repoRoot: "/test",
      file: testFile,
      content
    });

    const symbols = result.symbols.filter((s) => s.kind !== "file");
    expect(symbols.length).toBeGreaterThanOrEqual(1);

    const decoratedFunc = symbols.find((s) => s.name === "decorated_function");
    expect(decoratedFunc).toBeDefined();
  });

  it("should handle multi-line function signatures", () => {
    const content = `
def long_function(
    arg1: str,
    arg2: int,
    arg3: float
) -> bool:
    return True
`;

    const result = pythonTreeSitterAnalyzer.analyzeFile({
      repoRoot: "/test",
      file: testFile,
      content
    });

    const func = result.symbols.find((s) => s.name === "long_function");
    expect(func).toBeDefined();
    expect(func?.kind).toBe("function");
  });
});
