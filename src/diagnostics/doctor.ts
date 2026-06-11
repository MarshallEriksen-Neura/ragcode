import fs from "node:fs/promises";
import path from "node:path";
import { loadRuntimeConfig, redactRuntimeConfig } from "../config/runtime-config.js";
import type { ContextEngine } from "../core/contracts.js";
import { RagCodeEngine } from "../core/engine.js";
import type { IndexStatus, RepoIndex, SearchHit } from "../core/types.js";
import { createMcpServer } from "../mcp/server.js";
import { listToolDefinitions } from "../mcp/tools.js";

export interface DoctorOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  searchQuery?: string;
}

export interface DoctorCheck {
  ok: boolean;
  message: string;
  details?: unknown;
}

export interface DoctorReport {
  ok: boolean;
  cwd: string;
  node: DoctorCheck;
  runtime: {
    graph: DoctorCheck & { config?: unknown };
    semantic: DoctorCheck & { config?: unknown };
  };
  dependencies: {
    sqlite: DoctorCheck;
    lancedb: DoctorCheck;
    mcpSdk: DoctorCheck;
  };
  mcp: DoctorCheck & {
    toolCount: number;
    tools: string[];
  };
  smoke?: DoctorCheck & {
    repoRoot: string;
    indexed?: Pick<RepoIndex, "projectId" | "repoRoot" | "indexedAtMs"> & {
      files: number;
      chunks: number;
      symbols: number;
      edges: number;
      skippedFiles: number;
    };
    status?: Pick<IndexStatus, "fileCount" | "chunkCount" | "symbolCount" | "edgeCount" | "staleFileCount" | "pendingFileCount" | "skippedFileCount">;
    search?: {
      query: string;
      hits: Array<{
        filePath: string;
        startLine: number;
        endLine: number;
        score: number;
        source: SearchHit["source"];
        reason: string;
      }>;
    };
  };
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const runtime = readCheck(() => loadRuntimeConfig({ cwd, env, overrides: options.repoRoot ? { repoRoot: path.resolve(cwd, options.repoRoot) } : undefined }));
  const sqlite = await importCheck("node:sqlite", "node:sqlite import ok");
  const lancedb = await importCheck("@lancedb/lancedb", "@lancedb/lancedb import ok");
  const mcpSdk = await importCheck("@modelcontextprotocol/sdk/server/mcp.js", "@modelcontextprotocol/sdk import ok");
  const mcp = createMcpCheck();

  const report: DoctorReport = {
    ok: true,
    cwd,
    node: checkNodeVersion(),
    runtime: {
      graph: runtime.ok
        ? { ok: true, message: "graph runtime config ok", config: redactRuntimeConfig(runtime.value) }
        : { ok: false, message: runtime.message },
      semantic: runtime.ok
        ? { ok: true, message: "semantic runtime config ok", config: redactRuntimeConfig(runtime.value) }
        : { ok: false, message: runtime.message }
    },
    dependencies: {
      sqlite,
      lancedb,
      mcpSdk
    },
    mcp
  };

  if (options.repoRoot) {
    report.smoke = await runRepoSmoke({
      cwd,
      env,
      repoRoot: options.repoRoot,
      searchQuery: options.searchQuery ?? "export function class import"
    });
  }

  report.ok = [
    report.node,
    report.runtime.graph,
    report.runtime.semantic,
    report.dependencies.sqlite,
    report.dependencies.lancedb,
    report.dependencies.mcpSdk,
    report.mcp,
    report.smoke
  ].filter((check): check is DoctorCheck => Boolean(check)).every((check) => check.ok);

  return report;
}

function checkNodeVersion(): DoctorCheck {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    ok: Number.isFinite(major) && major >= 24,
    message: `Node ${process.version}; required >=24.0.0 for node:sqlite graph storage`
  };
}

function readCheck<T>(read: () => T): { ok: true; value: T } | { ok: false; message: string } {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

async function importCheck(specifier: string, okMessage: string): Promise<DoctorCheck> {
  try {
    await import(specifier);
    return { ok: true, message: okMessage };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

function createMcpCheck(): DoctorReport["mcp"] {
  const tools = listToolDefinitions();
  try {
    const server = createMcpServer(createNoopEngine());
    return {
      ok: !server.isConnected() && tools.length > 0,
      message: `MCP server factory ok with ${tools.length} tool(s)`,
      toolCount: tools.length,
      tools: tools.map((tool) => tool.name)
    };
  } catch (error) {
    return {
      ok: false,
      message: errorMessage(error),
      toolCount: tools.length,
      tools: tools.map((tool) => tool.name)
    };
  }
}

async function runRepoSmoke(options: Required<Pick<DoctorOptions, "cwd" | "env" | "repoRoot" | "searchQuery">>): Promise<NonNullable<DoctorReport["smoke"]>> {
  const repoRoot = path.resolve(options.cwd, options.repoRoot);
  let engine: RagCodeEngine | undefined;
  try {
    const stat = await fs.stat(repoRoot).catch((error) => {
      throw new Error(`repoRoot is not readable: ${repoRoot}. ${errorMessage(error)}`);
    });
    if (!stat.isDirectory()) {
      throw new Error(`repoRoot is not a directory: ${repoRoot}`);
    }

    engine = new RagCodeEngine({ cwd: options.cwd, env: options.env });
    const index = await engine.indexRepo(repoRoot);
    const status = await engine.indexStatus(repoRoot);
    const hits = await engine.searchCode({ repoRoot, query: options.searchQuery, limit: 5 });
    return {
      ok: true,
      message: "repo smoke indexed and searched successfully",
      repoRoot,
      indexed: {
        projectId: index.projectId,
        repoRoot: index.repoRoot,
        indexedAtMs: index.indexedAtMs,
        files: index.files.length,
        chunks: index.chunks.length,
        symbols: index.symbols.length,
        edges: index.edges.length,
        skippedFiles: index.skippedFiles.length
      },
      status: {
        fileCount: status.fileCount,
        chunkCount: status.chunkCount,
        symbolCount: status.symbolCount,
        edgeCount: status.edgeCount,
        staleFileCount: status.staleFileCount,
        pendingFileCount: status.pendingFileCount,
        skippedFileCount: status.skippedFileCount
      },
      search: {
        query: options.searchQuery,
        hits: hits.map((hit) => ({
          filePath: hit.chunk.filePath,
          startLine: hit.chunk.startLine,
          endLine: hit.chunk.endLine,
          score: hit.score,
          source: hit.source,
          reason: hit.reason
        }))
      }
    };
  } catch (error) {
    return {
      ok: false,
      message: errorMessage(error),
      repoRoot
    };
  } finally {
    engine?.close();
  }
}

function createNoopEngine(): ContextEngine {
  const handler = async (): Promise<unknown> => ({ ok: true });
  return new Proxy({}, {
    get: () => handler
  }) as ContextEngine;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
