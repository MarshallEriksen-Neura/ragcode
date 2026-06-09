#!/usr/bin/env node
import { Command } from "commander";
import { RagCodeEngine } from "../core/engine.js";
import { runDoctor } from "../diagnostics/doctor.js";
import { startStdioMcpServer } from "../mcp/server.js";
import { buildExplainImpactReport } from "../subgraph/impact-explainer.js";
import { expandNode, parseNodeRef } from "../subgraph/node-expander.js";

const program = new Command();

program.name("ragcode").description("Local code intelligence context engine").version("0.1.0");

program
  .command("index")
  .argument("<repoRoot>")
  .description("Index a repository")
  .action(async (repoRoot: string) => {
    await withEngine(repoRoot, async (engine) => {
      const result = await engine.indexRepo(repoRoot);
      console.log(JSON.stringify({ repoRoot: result.repoRoot, files: result.files.length, chunks: result.chunks.length }, null, 2));
    });
  });

program
  .command("search")
  .argument("<repoRoot>")
  .argument("<query>")
  .option("-l, --limit <number>", "maximum hits", parseNumber)
  .description("Search an already-indexed repository without re-indexing")
  .action(async (repoRoot: string, query: string, options: { limit?: number }) => {
    await withEngine(repoRoot, async (engine) => {
      const hits = await engine.searchCode({ repoRoot, query, limit: options.limit });
      console.log(JSON.stringify(hits.map((hit) => ({ filePath: hit.chunk.filePath, startLine: hit.chunk.startLine, endLine: hit.chunk.endLine, score: hit.score, source: hit.source, reason: hit.reason })), null, 2));
    });
  });

program
  .command("status")
  .argument("<repoRoot>")
  .description("Report persisted index and dirty watcher state without indexing")
  .action(async (repoRoot: string) => {
    await withEngine(repoRoot, async (engine) => {
      console.log(JSON.stringify(await engine.indexStatus(repoRoot), null, 2));
    });
  });

program
  .command("context")
  .argument("<repoRoot>")
  .argument("<query>")
  .option("-m, --mode <mode>", "context mode: auto/debug/feature/refactor/review/explain")
  .option("-b, --budget <chars>", "character budget", parseNumber)
  .description("Build a context pack")
  .action(async (repoRoot: string, query: string, options: { budget?: number; mode?: "auto" | "debug" | "feature" | "refactor" | "review" | "explain" }) => {
    await withEngine(repoRoot, async (engine) => {
      const context = await engine.getContext({ repoRoot, query, budgetChars: options.budget, mode: options.mode });
      console.log(JSON.stringify(context, null, 2));
    });
  });

program
  .command("owner")
  .argument("<repoRoot>")
  .argument("<query>")
  .description("Find likely owner files and symbols")
  .action(async (repoRoot: string, query: string) => {
    await withEngine(repoRoot, async (engine) => {
      console.log(JSON.stringify(await engine.findOwner(repoRoot, query), null, 2));
    });
  });

program
  .command("reuse")
  .argument("<repoRoot>")
  .argument("<query>")
  .option("-l, --limit <number>", "maximum candidates", parseNumber)
  .description("Find reusable existing code before implementing new behavior")
  .action(async (repoRoot: string, query: string, options: { limit?: number }) => {
    await withEngine(repoRoot, async (engine) => {
      console.log(JSON.stringify(await engine.findReuseCandidates({ repoRoot, query, limit: options.limit }), null, 2));
    });
  });

program
  .command("expand-node")
  .argument("<repoRoot>")
  .argument("<nodeRef>")
  .option("-e, --expansion <level>", "file_card/skeleton/focused_body/full_body")
  .option("-b, --budget <chars>", "character budget", parseNumber)
  .description("Expand one compact subgraph node under budget")
  .action(async (repoRoot: string, nodeRef: string, options: { expansion?: "file_card" | "skeleton" | "focused_body" | "full_body"; budget?: number }) => {
    await withEngine(repoRoot, async (engine) => {
      const parsed = parseNodeRef(nodeRef);
      const indexedFile = await engine.explainFile(repoRoot, parsed.filePath);
      console.log(JSON.stringify(expandNode({
        nodeRef,
        chunks: indexedFile.chunks,
        symbols: indexedFile.symbols,
        expansionLevel: options.expansion,
        budgetChars: options.budget
      }), null, 2));
    });
  });

program
  .command("impact")
  .argument("<repoRoot>")
  .argument("<target>")
  .description("Estimate structural impact for a file or symbol")
  .action(async (repoRoot: string, target: string) => {
    await withEngine(repoRoot, async (engine) => {
      console.log(JSON.stringify(await engine.impactAnalysis(repoRoot, target), null, 2));
    });
  });

program
  .command("explain-impact")
  .argument("<repoRoot>")
  .argument("<target>")
  .option("-b, --budget <chars>", "character budget", parseNumber)
  .option("--max-hops <number>", "maximum graph hops", parseNumber)
  .description("Explain blast radius as a verified minimal code subgraph")
  .action(async (repoRoot: string, target: string, options: { budget?: number; maxHops?: number }) => {
    await withEngine(repoRoot, async (engine) => {
      const subgraph = await engine.verifiedSubgraph({
        repoRoot,
        query: target,
        seed: target,
        mode: "impact",
        budgetChars: options.budget,
        maxHops: options.maxHops
      });
      console.log(JSON.stringify(buildExplainImpactReport(target, subgraph), null, 2));
    });
  });

program
  .command("tests")
  .argument("<repoRoot>")
  .argument("<target>")
  .description("Find likely related tests")
  .action(async (repoRoot: string, target: string) => {
    await withEngine(repoRoot, async (engine) => {
      console.log(JSON.stringify(await engine.relatedTests(repoRoot, target), null, 2));
    });
  });

program
  .command("trace-request-flow")
  .argument("<repoRoot>")
  .argument("<entry>")
  .option("-q, --query <query>", "optional flow query text")
  .option("-b, --budget <chars>", "character budget", parseNumber)
  .option("--max-hops <number>", "maximum graph hops", parseNumber)
  .description("Trace request/data flow as a verified ordered code subgraph")
  .action(async (repoRoot: string, entry: string, options: { query?: string; budget?: number; maxHops?: number }) => {
    await withEngine(repoRoot, async (engine) => {
      console.log(JSON.stringify(await engine.verifiedSubgraph({
        repoRoot,
        query: options.query ?? entry,
        seed: entry,
        mode: "flow",
        budgetChars: options.budget,
        maxHops: options.maxHops
      }), null, 2));
    });
  });

program
  .command("record-events")
  .argument("<repoRoot>")
  .argument("<filePaths...>")
  .option("--burst-threshold <number>", "dirty file count that activates burst mode", parseNumber)
  .option("--max-dirty-files <number>", "maximum dirty file paths to retain from one batch", parseNumber)
  .description("Record watcher file events as dirty state without indexing immediately")
  .action(async (repoRoot: string, filePaths: string[], options: { burstThreshold?: number; maxDirtyFiles?: number }) => {
    await withEngine(repoRoot, async (engine) => {
      console.log(JSON.stringify(await engine.recordFileEvents(repoRoot, filePaths, options), null, 2));
    });
  });

program
  .command("doctor")
  .argument("[repoRoot]")
  .option("-q, --query <query>", "query to use when repoRoot smoke indexing is enabled")
  .description("Check runtime dependencies, env config, MCP registration, and optional repo indexing/search smoke")
  .action(async (repoRoot: string | undefined, options: { query?: string }) => {
    const report = await runDoctor({ repoRoot, searchQuery: options.query });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  });

program
  .command("mcp")
  .description("Start the RagCode MCP server over stdio")
  .action(async () => {
    await startStdioMcpServer();
  });

program.parseAsync().catch((error: unknown) => {
  const message = formatCliError(error);
  console.error(message);
  process.exitCode = 1;
});

async function withEngine<T>(cwd: string | undefined, fn: (engine: RagCodeEngine) => Promise<T>): Promise<T> {
  const engine = new RagCodeEngine({ cwd, env: cliEnv() });
  try {
    return await fn(engine);
  } finally {
    engine.close();
  }
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number: ${value}`);
  return parsed;
}

function cliEnv(): NodeJS.ProcessEnv {
  if (process.env.RAGCODE_GRAPH_STORE) return process.env;
  return {
    ...process.env,
    RAGCODE_GRAPH_STORE: "sqlite"
  };
}

function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Workspace is not indexed|Missing workspace|Repository is not indexed/i.test(message)) {
    return `${message}\nRun "ragcode index <repoRoot>" first, then retry the read command. CLI reads default to SQLite at <repoRoot>/.ragcode/graph.sqlite unless RAGCODE_SQLITE_PATH is set.`;
  }
  return message;
}
