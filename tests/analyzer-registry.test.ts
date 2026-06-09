import { describe, expect, it } from "vitest";
import { analyzerFor, analyzeFile } from "../src/index.js";
import type { CodeFile } from "../src/index.js";

describe("language analyzer registry", () => {
  it("routes TypeScript and JavaScript through structural analyzers", () => {
    expect(analyzerFor("typescript").capabilities).toEqual(expect.arrayContaining(["symbols", "imports", "exports", "calls"]));
    expect(analyzerFor("javascript").capabilities).toEqual(expect.arrayContaining(["symbols", "imports", "exports", "calls"]));
    expect(analyzerFor("python").capabilities).toEqual(expect.arrayContaining(["symbols", "imports", "exports", "calls"]));
    expect(analyzerFor("go").capabilities).toEqual(expect.arrayContaining(["symbols", "imports", "exports", "calls"]));
    expect(analyzerFor("rust").capabilities).toEqual(expect.arrayContaining(["symbols", "imports", "exports", "calls"]));
    expect(analyzerFor("java").capabilities).toEqual(expect.arrayContaining(["symbols", "imports", "exports", "calls"]));
  });

  it("indexes Python functions, imports, and local call edges", () => {
    const file: CodeFile = {
      projectId: "project",
      path: "app.py",
      absolutePath: "app.py",
      language: "python",
      sizeBytes: 23,
      contentHash: "hash",
      modifiedAtMs: 1
    };

    const analysis = analyzeFile("repo", file, "import json\n\ndef hello():\n    return load_user()\n\ndef load_user():\n    return json.loads('{}')\n");

    expect(analysis.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({
        filePath: "app.py",
        name: "hello",
        kind: "function",
        language: "python",
        exported: true
      }),
      expect.objectContaining({
        filePath: "app.py",
        name: "load_user",
        kind: "function"
      })
    ]));
    expect(analysis.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "imports", metadata: expect.objectContaining({ source: "json" }) }),
      expect.objectContaining({ kind: "calls", metadata: expect.objectContaining({ targetName: "load_user" }) })
    ]));
    expect(analysis.chunks.some((chunk) => chunk.symbolName === "hello")).toBe(true);
  });

  it("indexes Go functions, types, imports, and local call edges", () => {
    const file: CodeFile = {
      projectId: "project",
      path: "server.go",
      absolutePath: "server.go",
      language: "go",
      sizeBytes: 23,
      contentHash: "hash",
      modifiedAtMs: 1
    };

    const analysis = analyzeFile("repo", file, [
      "package main",
      "",
      "import \"net/http\"",
      "",
      "type Server struct {}",
      "",
      "func HandleCheckout(w http.ResponseWriter, r *http.Request) {",
      "  writeJSON(w)",
      "}",
      "",
      "func writeJSON(w http.ResponseWriter) {}"
    ].join("\n"));

    expect(analysis.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Server", kind: "type", exported: true }),
      expect.objectContaining({ name: "HandleCheckout", kind: "function", exported: true }),
      expect.objectContaining({ name: "writeJSON", kind: "function", exported: false })
    ]));
    expect(analysis.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "imports", metadata: expect.objectContaining({ source: "net/http" }) }),
      expect.objectContaining({ kind: "calls", metadata: expect.objectContaining({ targetName: "writeJSON" }) })
    ]));
  });

  it("indexes Rust functions, types, imports, and local call edges", () => {
    const file: CodeFile = {
      projectId: "project",
      path: "src/lib.rs",
      absolutePath: "src/lib.rs",
      language: "rust",
      sizeBytes: 23,
      contentHash: "hash",
      modifiedAtMs: 1
    };

    const analysis = analyzeFile("repo", file, [
      "use crate::billing::Invoice;",
      "",
      "pub struct Handler {}",
      "",
      "pub fn handle_checkout() {",
      "  write_invoice();",
      "}",
      "",
      "fn write_invoice() {}"
    ].join("\n"));

    expect(analysis.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Handler", kind: "type", exported: true }),
      expect.objectContaining({ name: "handle_checkout", kind: "function", exported: true }),
      expect.objectContaining({ name: "write_invoice", kind: "function", exported: false })
    ]));
    expect(analysis.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "imports", metadata: expect.objectContaining({ source: "crate::billing::Invoice" }) }),
      expect.objectContaining({ kind: "calls", metadata: expect.objectContaining({ targetName: "write_invoice" }) })
    ]));
  });

  it("indexes Java classes, methods, imports, and local call edges", () => {
    const file: CodeFile = {
      projectId: "project",
      path: "src/BillingController.java",
      absolutePath: "src/BillingController.java",
      language: "java",
      sizeBytes: 23,
      contentHash: "hash",
      modifiedAtMs: 1
    };

    const analysis = analyzeFile("repo", file, [
      "import com.acme.BillingService;",
      "",
      "public class BillingController {",
      "  public void checkout() {",
      "    createInvoice();",
      "  }",
      "",
      "  private void createInvoice() {}",
      "}"
    ].join("\n"));

    expect(analysis.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "BillingController", kind: "class", exported: true }),
      expect.objectContaining({ name: "checkout", kind: "method", exported: true }),
      expect.objectContaining({ name: "createInvoice", kind: "method", exported: false })
    ]));
    expect(analysis.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "imports", metadata: expect.objectContaining({ source: "com.acme.BillingService" }) }),
      expect.objectContaining({ kind: "calls", metadata: expect.objectContaining({ targetName: "createInvoice" }) })
    ]));
  });

  it("keeps unsupported languages explicit through the fallback analyzer", () => {
    expect(analyzerFor("markdown").capabilities).toEqual([]);
  });
});
