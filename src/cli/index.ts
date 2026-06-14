#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { loadDotEnv } from "../config/dotenv.js";
import { getPackageVersion } from "../config/package-info.js";
import { createRuntimeComponentsForRepo } from "../config/runtime-config.js";
import type { IndexProgressEvent } from "../core/types.js";
import { RagCodeEngine } from "../core/engine.js";
import { runConfigureCommand } from "./configure.js";
import { runDoctor } from "../diagnostics/doctor.js";
import { startStdioMcpServer } from "../mcp/server.js";
import { buildExplainImpactReport } from "../subgraph/impact-explainer.js";
import { expandNode, parseNodeRef } from "../subgraph/node-expander.js";
import { FileWatchDaemon } from "../watch/watch-daemon.js";
import { WatcherLockError, readWatcherLiveness } from "../watch/watcher-liveness.js";
import { installWatcherService, uninstallWatcherService, watcherServiceStatus, UnsupportedPlatformError } from "../service/service-manager.js";
import { DEFAULT_BOOTSTRAP_BATCH_FILES, indexRepoWithBootstrapBatch } from "../indexing/batch-bootstrap.js";
import { createIndexProgressRecorder } from "../indexing/index-progress-state.js";
import { normalizeServiceInstallOptions } from "./service-install-options.js";
import { runInitConfig } from "../../scripts/init-config.js";
import { printInitOnboardingSummary, runInitOnboarding } from "./init-onboarding.js";
import { parseSetupMcpArgs, setupMCP } from "../../scripts/setup-mcp.js";
import { runUpdate } from "./update.js";
import { truncateContextPack } from "../context/truncate-context-pack.js";

loadDotEnv();

const program = new Command();

program.name("ragcode").description("Local code intelligence context engine").version(getPackageVersion());

const legacySetupIndex = process.argv.indexOf("--setup");
if (legacySetupIndex >= 0) {
  const setupTarget = process.argv[legacySetupIndex + 1];
  if (setupTarget !== "mcp") {
    console.error('Unsupported --setup target. Expected "mcp".');
    process.exit(1);
  }
  const rawArgs = process.argv.slice(2);
  const setupArgs = rawArgs.filter((arg, index) => index !== legacySetupIndex - 2 && index !== legacySetupIndex - 1);
  try {
    setupMCP({
      ...parseSetupMcpArgs(setupArgs, { defaultClient: "all" }),
      cwd: process.cwd(),
      env: process.env
    });
  } catch (error) {
    console.error(`MCP setup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  process.exit(0);
}

program
  .command("index")
  .argument("<repoRoot>")
  .option("--max-batch-files <number>", "maximum files in the first empty-index bootstrap batch", parseNumber)
  .option("--max-analysis-memory-mb <number>", "abort before continuing when heap exceeds this many MB", parseNumber)
  .option("--semantic-on-bootstrap", "write semantic vectors during the first partial bootstrap batch")
  .option("--full", "force the legacy all-at-once full index")
  .description("Index a repository")
  .action(async (repoRoot: string, options: { maxBatchFiles?: number; maxAnalysisMemoryMb?: number; semanticOnBootstrap?: boolean; full?: boolean }) => {
    assertPositive("--max-batch-files", options.maxBatchFiles);
    assertPositive("--max-analysis-memory-mb", options.maxAnalysisMemoryMb);
    if (process.stdout.isTTY) {
      const { runIndexProgressTui } = await import("./tui/index-progress.js");
      await runIndexProgressTui({
        repoRoot,
        run: async (onProgress) => withEngine(repoRoot, (engine) => indexRepoForCli(engine, repoRoot, options, onProgress))
      });
      return;
    }
    await withEngine(repoRoot, async (engine) => {
      const progress = createIndexProgressRecorder(repoRoot);
      const onProgress = (event: Parameters<typeof progress.onProgress>[0]): void => {
        console.error(JSON.stringify({ index: event }));
        progress.onProgress(event);
      };
      const result = await indexRepoForCli(engine, repoRoot, options, onProgress).catch(async (error: unknown) => {
        await progress.recordFailure(error);
        throw error;
      });
      await progress.flush();
      console.log(JSON.stringify({
        repoRoot: result.repoRoot,
        files: result.files.length,
        fullReindex: result.fullReindex,
        affectedFiles: result.affectedFiles,
        partialBootstrap: result.partialBootstrap ?? false,
        semanticDeferred: result.semanticDeferred ?? false,
        pendingFiles: (await engine.indexStatus(repoRoot).catch(() => undefined))?.pendingFileCount,
        chunks: result.chunks.length,
        skippedFiles: result.skippedFiles.length,
        analysisWarnings: result.analysisWarnings ?? []
      }, null, 2));
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
      let context = await engine.getContext({ repoRoot, query, budgetChars: options.budget, mode: options.mode });

      // Apply budget enforcement
      const serialized = JSON.stringify(context);
      const actualSize = serialized.length;
      const budget = options.budget ?? 18_000;

      if (actualSize > budget * 1.2) {
        context = truncateContextPack(context, budget);
      }

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
  .command("watch")
  .argument("<repoRoot>")
  .option("--batch-delay <ms>", "delay before background indexing after dirty events", parseNumber)
  .option("--quiet <ms>", "minimum quiet period before indexing", parseNumber)
  .option("--flush-events <ms>", "delay before flushing observed file events to dirty state", parseNumber)
  .option("--await-write <ms>", "await-write-finish stability threshold", parseNumber)
  .option("--burst-threshold <number>", "dirty file count that activates burst mode", parseNumber)
  .option("--max-dirty-files <number>", "maximum dirty file paths to retain from one batch", parseNumber)
  .option("--max-batch-files <number>", "maximum dirty file paths to mark indexing in one scheduler batch", parseNumber)
  .option("--max-analysis-memory-mb <number>", "abort an indexing batch when heap exceeds this many MB", parseNumber)
  .option("--poll", "use polling instead of native fs.watch")
  .option("--no-auto-index", "record dirty events but do not run background refresh")
  .option("--no-index-on-start", "fail if the repo is not already indexed instead of indexing before watching")
  .description("Run a long-lived filesystem watcher daemon with event journal replay and background batch indexing")
  .action(async (repoRoot: string, options: {
    batchDelay?: number;
    quiet?: number;
    flushEvents?: number;
    awaitWrite?: number;
    burstThreshold?: number;
    maxDirtyFiles?: number;
    maxBatchFiles?: number;
    maxAnalysisMemoryMb?: number;
    poll?: boolean;
    autoIndex?: boolean;
    indexOnStart?: boolean;
  }) => {
    const engine = buildCliEngine(repoRoot);
    const watchOptions = normalizeWatchOptions(options);
    if (process.stdout.isTTY) {
      const { createWatchStatusTui } = await import("./tui/watch-status.js");
      const absoluteRoot = path.resolve(repoRoot);
      let tui: ReturnType<typeof createWatchStatusTui> | undefined;
      let shuttingDown = false;
      const daemon = new FileWatchDaemon(engine, repoRoot, {
        ...watchOptions,
        onStatus: (status) => tui?.update(status)
      });
      tui = createWatchStatusTui({
        repoRoot: absoluteRoot,
        running: false,
        ready: false,
        bufferedEvents: 0,
        scheduler: {
          repoRoot: absoluteRoot,
          running: false,
          scheduled: false,
          indexing: false,
          pendingFiles: 0,
          indexingFiles: 0
        }
      });
      const shutdown = async (): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        await daemon.stop();
        engine.close();
        tui?.unmount();
      };
      const exitFromSignal = (): void => {
        void shutdown().finally(() => process.exit(0));
      };
      process.once("SIGINT", exitFromSignal);
      process.once("SIGTERM", exitFromSignal);
      try {
        await daemon.start();
        tui.update(await daemon.status());
        await tui.waitUntilExit();
      } catch (error) {
        if (error instanceof WatcherLockError) {
          // Another live watcher already owns this repo. shutdown() (guarded, runs in finally)
          // tears down our half-started daemon and closes the engine; just surface the reason.
          tui?.unmount();
          console.error(`⚠️  ${error.message}`);
          return;
        }
        throw error;
      } finally {
        process.removeListener("SIGINT", exitFromSignal);
        process.removeListener("SIGTERM", exitFromSignal);
        await shutdown();
      }
      return;
    }
    const daemon = new FileWatchDaemon(engine, repoRoot, {
      ...watchOptions,
      onStatus: (status) => {
        console.error(JSON.stringify({ watcher: status }));
      }
    });
    const shutdown = async (): Promise<void> => {
      await daemon.stop();
      engine.close();
    };
    process.once("SIGINT", () => {
      void shutdown().finally(() => process.exit(0));
    });
    process.once("SIGTERM", () => {
      void shutdown().finally(() => process.exit(0));
    });
    try {
      await daemon.start();
    } catch (error) {
      if (error instanceof WatcherLockError) {
        engine.close();
        console.error(error.message);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    console.log(JSON.stringify(await daemon.status(), null, 2));
  });

const service = program
  .command("service")
  .description("Manage the background watcher as an OS service (one per repo) so freshness survives reboots");

service
  .command("install")
  .argument("<repoRoot>")
  .option("--poll", "register the watcher with polling instead of native fs.watch")
  .option("--index-now", "run one bounded index batch before registering the service", false)
  .option("--bootstrap-batch-size <number>", "maximum files in the explicit --index-now bootstrap batch", parseNumber)
  .option("--max-analysis-memory-mb <number>", "abort the explicit --index-now bootstrap when heap exceeds this many MB", parseNumber)
  .description("Register and start a background watcher service for this repo (systemd user / launchd / Task Scheduler)")
  .action(async (repoRoot: string, options: { poll?: boolean; indexNow?: boolean; bootstrapBatchSize?: number; maxAnalysisMemoryMb?: number }) => {
    const installOptions = normalizeServiceInstallOptions(options);
    if (installOptions.indexNow) await withEngine(repoRoot, (engine) => indexRepoWithBootstrapBatch(engine, repoRoot, {
      maxBatchFiles: installOptions.bootstrapBatchSize,
      maxAnalysisMemoryMb: installOptions.maxAnalysisMemoryMb,
      disableSemanticOnBootstrap: true
    }));
    try {
      const result = await installWatcherService(repoRoot, { extraArgs: installOptions.extraArgs, indexOnStart: false });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

service
  .command("uninstall")
  .argument("<repoRoot>")
  .description("Stop and remove the background watcher service for this repo")
  .action(async (repoRoot: string) => {
    try {
      const result = await uninstallWatcherService(repoRoot);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

service
  .command("status")
  .argument("<repoRoot>")
  .description("Report whether a watcher service is registered and whether the watcher process is alive")
  .action(async (repoRoot: string) => {
    const [registration, liveness] = await Promise.all([
      watcherServiceStatus(repoRoot),
      readWatcherLiveness(path.resolve(repoRoot))
    ]);
    console.log(JSON.stringify({ registration, liveness }, null, 2));
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

program
  .command("init")
  .argument("[directory]")
  .option("-y, --yes", "write offline-first defaults without interactive prompts")
  .option("--defaults", "write offline-first defaults without interactive prompts")
  .option("--no-index", "skip the bounded initial index batch")
  .option("--no-watch", "skip background watcher service installation")
  .option("--poll", "install the watcher service with polling")
  .option("--max-batch-files <number>", "maximum files in the initial onboarding index batch", parseNumber)
  .option("--max-analysis-memory-mb <number>", "abort indexing before continuing when heap exceeds this many MB", parseNumber)
  .description("Initialize RagCode configuration (interactive first-run setup)")
  .action(async (directory: string | undefined, options: { yes?: boolean; defaults?: boolean; index?: boolean; watch?: boolean; poll?: boolean; maxBatchFiles?: number; maxAnalysisMemoryMb?: number }) => {
    const targetDir = directory || process.cwd();
    const defaults = Boolean(options.yes || options.defaults);
    assertPositive("--max-batch-files", options.maxBatchFiles);
    assertPositive("--max-analysis-memory-mb", options.maxAnalysisMemoryMb);
    if (!defaults && process.stdin.isTTY) {
      // Interactive first-run goes through the Ink wizard (same app as `ragcode configure`,
      // first_run mode defaults index/setup-mcp to yes). Loaded lazily to keep --defaults light.
      const { runInkConfigure } = await import("./configure/run.js");
      await runInkConfigure({ repoRoot: targetDir, mode: "first_run" });
      return;
    }
    const init = await runInitConfig({ targetDir, defaults: true, printNextSteps: false });
    const onboarding = await runInitOnboarding({
      repoRoot: init.targetDir,
      indexNow: options.index !== false,
      installWatcher: options.watch !== false,
      poll: options.poll ?? process.platform === "win32",
      maxBatchFiles: options.maxBatchFiles,
      maxAnalysisMemoryMb: options.maxAnalysisMemoryMb
    });
    printInitOnboardingSummary(onboarding);

    console.log("\n🚀 Summary / next steps:");
    if (options.index === false) console.log("  ragcode index .            # build the index");
    console.log("  ragcode setup-mcp          # register the MCP server");
    if (options.watch === false) console.log("  ragcode service install .  # keep the index fresh automatically");
    console.log("  ragcode configure          # adjust storage/embedding later");
    console.log("  ragcode dashboard          # observe graph/search/context/watch");
  });

program
  .command("setup-mcp")
  .option("--config <path>", "Custom MCP config path")
  .option("--print", "Print config without writing")
  .option("--include-secrets", "Include real secrets instead of redacted placeholders")
  .option("--client <client>", "Client format: claude (Desktop), claude-code (project .mcp.json), codex (~/.codex/config.toml), or generic")
  .option("--force", "Overwrite an existing ragcode entry without prompting")
  .description("Register RagCode as an MCP server for Claude Desktop, Claude Code, or Codex")
  .action(async (options: { config?: string; print?: boolean; includeSecrets?: boolean; client?: "claude" | "claude-code" | "codex" | "generic"; force?: boolean }) => {
    setupMCP({
      configPath: options.config,
      print: options.print,
      includeSecrets: options.includeSecrets,
      client: options.client,
      force: options.force,
      cwd: process.cwd(),
      env: process.env
    });
  });

program
  .command("configure")
  .argument("[repoRoot]")
  .option("--show", "Print the effective runtime config (secrets redacted) and exit")
  .option("--test", "Test the effective embedding provider without changing config")
  .option("--graph-store <store>", "Graph store: memory or sqlite")
  .option("--sqlite-path <path>", "SQLite graph database path")
  .option("--semantic-store <store>", "Semantic store: memory or lancedb")
  .option("--lancedb-uri <path>", "LanceDB storage path")
  .option("--embedding-provider <provider>", "Embedding provider: deterministic or openai-compatible")
  .option("--base-url <url>", "Embedding API base URL")
  .option("--model <model>", "Embedding model name")
  .option("--api-key <key>", "Embedding API key (persisted to .ragcode/config.json)")
  .option("--dimensions <number>", "Embedding dimensions", parseNumber)
  .option("--request-dimensions <bool>", "Send dimensions parameter to the provider (true/false)")
  .description("Edit storage and embedding runtime config from the terminal, with embedding test")
  .action(async (repoRoot: string | undefined, options: {
    show?: boolean;
    test?: boolean;
    graphStore?: string;
    sqlitePath?: string;
    semanticStore?: string;
    lancedbUri?: string;
    embeddingProvider?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    dimensions?: number;
    requestDimensions?: string;
  }) => {
    await runConfigureCommand(repoRoot, {
      show: options.show,
      test: options.test,
      graphStore: options.graphStore,
      sqlitePath: options.sqlitePath,
      semanticStore: options.semanticStore,
      lancedbUri: options.lancedbUri,
      embeddingProvider: options.embeddingProvider,
      embeddingBaseUrl: options.baseUrl,
      embeddingModel: options.model,
      embeddingApiKey: options.apiKey,
      embeddingDimensions: options.dimensions,
      embeddingRequestDimensions: options.requestDimensions === undefined ? undefined : options.requestDimensions === "true"
    });
  });

program
  .command("update")
  .option("--check", "only report whether a newer version is available; don't install")
  .option("--pm <manager>", "package manager to use: npm, pnpm, or yarn (default: auto-detect)")
  .option("--version <version>", "install a specific version or dist-tag instead of latest")
  .description("Update the globally-installed RagCode CLI to the latest version")
  .action(async (options: { check?: boolean; pm?: string; version?: string }) => {
    const result = await runUpdate({ checkOnly: options.check, packageManager: options.pm, version: options.version });
    console.log(result.message);
    if (!result.ok) process.exitCode = 1;
  });

program
  .command("dashboard")
  .description("Start the Web observability dashboard API (graph/search/context/watch observation)")
  .action(async () => {
    await import("../web/server.js");
  });

program.parseAsync().catch((error: unknown) => {
  const message = formatCliError(error);
  console.error(message);
  process.exitCode = 1;
});

async function withEngine<T>(repoRoot: string | undefined, fn: (engine: RagCodeEngine) => Promise<T>): Promise<T> {
  const engine = buildCliEngine(repoRoot);
  try {
    return await fn(engine);
  } finally {
    engine.close();
  }
}

// CLI commands resolve runtime config through the shared loader so that explicit args, env,
// .ragcode/config.json, and offline-first defaults (sqlite + lancedb + deterministic) apply
// uniformly across CLI, MCP, Web, and doctor. The engine constructor itself stays env-driven
// for embedded/library/test usage.
function buildCliEngine(repoRoot: string | undefined): RagCodeEngine {
  const components = createRuntimeComponentsForRepo({
    cwd: process.cwd(),
    overrides: repoRoot ? { repoRoot } : undefined
  });
  return new RagCodeEngine({
    cwd: repoRoot,
    graphStore: components.graphStore,
    semanticStore: components.semanticStore,
    embeddingProvider: components.embeddingProvider
  });
}

function indexRepoForCli(
  engine: RagCodeEngine,
  repoRoot: string,
  options: { maxBatchFiles?: number; maxAnalysisMemoryMb?: number; semanticOnBootstrap?: boolean; full?: boolean },
  onProgress: (event: IndexProgressEvent) => void
): Promise<import("../core/types.js").RepoIndex> {
  const indexOptions = {
    onProgress,
    maxAnalysisMemoryMb: options.maxAnalysisMemoryMb ?? envPositiveNumber("RAGCODE_MAX_ANALYSIS_MEMORY_MB"),
    disableSemanticOnBootstrap: options.semanticOnBootstrap !== true
  };
  if (options.full) return engine.indexRepo(repoRoot, indexOptions);
  return indexRepoWithBootstrapBatch(engine, repoRoot, {
    ...indexOptions,
    maxBatchFiles: options.maxBatchFiles ?? envPositiveNumber("RAGCODE_MAX_INDEX_FILES_PER_BATCH") ?? DEFAULT_BOOTSTRAP_BATCH_FILES
  });
}

function envPositiveNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

function normalizeWatchOptions(options: {
  batchDelay?: number;
  quiet?: number;
  flushEvents?: number;
  awaitWrite?: number;
  burstThreshold?: number;
  maxDirtyFiles?: number;
  maxBatchFiles?: number;
  maxAnalysisMemoryMb?: number;
  poll?: boolean;
  autoIndex?: boolean;
  indexOnStart?: boolean;
}): ConstructorParameters<typeof FileWatchDaemon>[2] {
  assertPositive("--batch-delay", options.batchDelay);
  assertPositive("--quiet", options.quiet);
  assertPositive("--flush-events", options.flushEvents);
  assertPositive("--await-write", options.awaitWrite);
  assertPositive("--max-dirty-files", options.maxDirtyFiles);
  assertPositive("--max-batch-files", options.maxBatchFiles);
  assertPositive("--max-analysis-memory-mb", options.maxAnalysisMemoryMb);
  assertPositive("--burst-threshold", options.burstThreshold);
  return {
    batchDelayMs: options.batchDelay,
    minQuietMs: options.quiet,
    flushEventsMs: options.flushEvents,
    awaitWriteFinishMs: options.awaitWrite,
    burstThreshold: options.burstThreshold,
    maxDirtyFiles: options.maxDirtyFiles,
    maxBatchFiles: options.maxBatchFiles,
    maxAnalysisMemoryMb: options.maxAnalysisMemoryMb,
    usePolling: options.poll,
    autoIndex: options.autoIndex,
    indexOnStart: options.indexOnStart
  };
}

function assertPositive(name: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new Error(`${name} must be a positive number.`);
  }
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid number: ${value}`);
  return parsed;
}

function formatCliError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Workspace is not indexed|Missing workspace|Repository is not indexed/i.test(message)) {
    return `${message}\nRun "ragcode index <repoRoot>" first, then retry the read command. CLI reads default to SQLite at <repoRoot>/.ragcode/graph.sqlite unless RAGCODE_SQLITE_PATH is set.`;
  }
  return message;
}
