import path from "node:path";
import { render } from "ink";
import { createRuntimeComponentsForRepo, loadRuntimeConfig, redactRuntimeConfig } from "../../config/runtime-config.js";
import { RagCodeEngine } from "../../core/engine.js";
import { runEmbeddingTest } from "../../diagnostics/embedding-test.js";
import { setupMCP } from "../../../scripts/setup-mcp.js";
import { applyConfigureUpdates } from "../configure.js";
import { ConfigureApp } from "./app.js";
import { createWizardState, wizardResult, type WizardMode, type WizardState } from "./state.js";

// Orchestrates the Ink wizard: render the UI, then execute the collected actions in PRD
// order (test embedding -> save -> index -> setup MCP -> summary). All config IO stays in
// runtime-config/configure; the Ink app only collects answers.
export async function runInkConfigure(options: { repoRoot: string; mode: WizardMode }): Promise<void> {
  const repoRoot = path.resolve(options.repoRoot);
  const current = redactRuntimeConfig(loadRuntimeConfig({ cwd: repoRoot, overrides: { repoRoot } }));

  let finalState: WizardState | undefined;
  const { waitUntilExit } = render(
    <ConfigureApp
      initialState={createWizardState(options.mode, repoRoot, current)}
      onFinish={(state) => {
        finalState = state;
      }}
    />
  );
  await waitUntilExit();

  const result = finalState ? wizardResult(finalState) : undefined;
  if (!result) {
    console.log("Configuration unchanged.");
    return;
  }

  if (result.actions.testEmbedding) {
    // Test against the would-be config before persisting anything.
    const test = await runEmbeddingTest({ cwd: repoRoot, overrides: { repoRoot, ...result.updates } });
    if (test.ok) {
      console.log(`🧪 Embedding test OK: provider=${test.provider}${test.model ? ` model=${test.model}` : ""} dimensions=${test.dimensions} latency=${test.latencyMs}ms`);
    } else {
      console.log(`🧪 Embedding test FAILED (${test.failure?.kind}): ${test.failure?.message}`);
      console.log("   Saving anyway keeps the config editable via `ragcode configure`; the offline deterministic provider always works.");
    }
  }

  if (!result.actions.save) {
    console.log("Configuration not saved.");
    return;
  }

  const saved = await applyConfigureUpdates({ repoRoot, updates: result.updates });
  console.log(`✅ Configuration saved to: ${saved.configPath}`);

  if (result.actions.indexNow) {
    console.log("📦 Indexing repository...");
    const components = createRuntimeComponentsForRepo({ cwd: repoRoot, overrides: { repoRoot } });
    const engine = new RagCodeEngine({
      cwd: repoRoot,
      graphStore: components.graphStore,
      semanticStore: components.semanticStore,
      embeddingProvider: components.embeddingProvider
    });
    try {
      const index = await engine.indexRepo(repoRoot);
      console.log(`✅ Indexed ${index.files.length} files, ${index.chunks.length} chunks.`);
    } finally {
      engine.close();
    }
  }

  if (result.actions.setupMcp) {
    setupMCP({ cwd: repoRoot, env: process.env });
  }

  if (result.actions.installWatcherService) {
    // Loaded lazily so the wizard doesn't pull in the service layer unless the user opts in.
    const { installWatcherService } = await import("../../service/service-manager.js");
    try {
      const service = await installWatcherService(repoRoot);
      console.log(service.ok ? `👁  ${service.message}` : `⚠️  ${service.message}`);
    } catch (error) {
      console.log(`⚠️  Could not install the background watcher service: ${error instanceof Error ? error.message : String(error)}`);
      console.log("   You can still keep the index fresh by running `ragcode watch .` manually.");
    }
  }

  console.log("\n🚀 Summary / next steps:");
  if (!result.actions.indexNow) console.log("  ragcode index .            # build the index");
  if (!result.actions.setupMcp) console.log("  ragcode setup-mcp          # register the MCP server");
  if (!result.actions.installWatcherService) console.log("  ragcode service install .  # keep the index fresh automatically");
  console.log("  ragcode configure          # adjust storage/embedding later");
  console.log("  ragcode dashboard          # observe graph/search/context/watch");
}
