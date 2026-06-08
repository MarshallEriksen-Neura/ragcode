#!/usr/bin/env node
import { Command } from "commander";
import { RagCodeEngine } from "../core/engine.js";

const program = new Command();
const engine = new RagCodeEngine();

program.name("ragcode").description("Local code intelligence context engine").version("0.1.0");

program
  .command("index")
  .argument("<repoRoot>")
  .description("Index a repository")
  .action(async (repoRoot: string) => {
    const result = await engine.indexRepo(repoRoot);
    console.log(JSON.stringify({ repoRoot: result.repoRoot, files: result.files.length, chunks: result.chunks.length }, null, 2));
  });

program
  .command("search")
  .argument("<repoRoot>")
  .argument("<query>")
  .option("-l, --limit <number>", "maximum hits", parseNumber)
  .description("Search indexed code in the current process")
  .action(async (repoRoot: string, query: string, options: { limit?: number }) => {
    await engine.indexRepo(repoRoot);
    const hits = await engine.searchCode({ repoRoot, query, limit: options.limit });
    console.log(JSON.stringify(hits.map((hit) => ({ filePath: hit.chunk.filePath, startLine: hit.chunk.startLine, endLine: hit.chunk.endLine, score: hit.score, source: hit.source, reason: hit.reason })), null, 2));
  });

program
  .command("context")
  .argument("<repoRoot>")
  .argument("<query>")
  .option("-m, --mode <mode>", "context mode: auto/debug/feature/refactor/review/explain")
  .option("-b, --budget <chars>", "character budget", parseNumber)
  .description("Build a context pack")
  .action(async (repoRoot: string, query: string, options: { budget?: number; mode?: "auto" | "debug" | "feature" | "refactor" | "review" | "explain" }) => {
    await engine.indexRepo(repoRoot);
    const context = await engine.getContext({ repoRoot, query, budgetChars: options.budget, mode: options.mode });
    console.log(JSON.stringify(context, null, 2));
  });

program
  .command("owner")
  .argument("<repoRoot>")
  .argument("<query>")
  .description("Find likely owner files and symbols")
  .action(async (repoRoot: string, query: string) => {
    await engine.indexRepo(repoRoot);
    console.log(JSON.stringify(await engine.findOwner(repoRoot, query), null, 2));
  });

program
  .command("impact")
  .argument("<repoRoot>")
  .argument("<target>")
  .description("Estimate structural impact for a file or symbol")
  .action(async (repoRoot: string, target: string) => {
    await engine.indexRepo(repoRoot);
    console.log(JSON.stringify(await engine.impactAnalysis(repoRoot, target), null, 2));
  });

program
  .command("tests")
  .argument("<repoRoot>")
  .argument("<target>")
  .description("Find likely related tests")
  .action(async (repoRoot: string, target: string) => {
    await engine.indexRepo(repoRoot);
    console.log(JSON.stringify(await engine.relatedTests(repoRoot, target), null, 2));
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number: ${value}`);
  return parsed;
}
