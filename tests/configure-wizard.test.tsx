import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import type { RedactedRuntimeConfig } from "../src/config/runtime-config.js";
import { ConfigureApp } from "../src/cli/configure/app.js";
import {
  answerCurrentStep,
  cancelWizard,
  createWizardState,
  currentStep,
  wizardResult,
  type WizardState
} from "../src/cli/configure/state.js";

const baseConfig: RedactedRuntimeConfig = {
  repoRoot: "/repo",
  configPath: "/repo/.ragcode/config.json",
  graphStore: "sqlite",
  sqlitePath: "/repo/.ragcode/graph.sqlite",
  semanticStore: "lancedb",
  lancedbUri: "/repo/.ragcode/lancedb",
  lanceDbTableName: "code_chunks",
  embeddingProvider: "deterministic",
  embeddingBaseUrl: "https://api.openai.com/v1",
  embeddingModel: undefined,
  embeddingDimensions: undefined,
  embeddingRequestDimensions: false,
  embeddingBatchSize: 64,
  embeddingConcurrency: 1,
  semanticMaxChunks: undefined,
  embeddingApiKey: "unset",
  sources: {}
};

function acceptDefaults(state: WizardState): WizardState {
  let next = state;
  while (!next.done && !next.cancelled) next = answerCurrentStep(next, "");
  return next;
}

describe("configure wizard state machine", () => {
  it("accepts defaults end-to-end and saves without provider detail steps", () => {
    const state = acceptDefaults(createWizardState("configure", "/repo", baseConfig));
    const result = wizardResult(state);

    expect(state.done).toBe(true);
    expect(result?.updates).toMatchObject({
      graphStore: "sqlite",
      semanticStore: "lancedb",
      embeddingProvider: "deterministic"
    });
    expect(result?.updates.embeddingBaseUrl).toBeUndefined();
    expect(result?.actions).toEqual({ testEmbedding: true, save: true, indexNow: false, setupMcp: false });
  });

  it("walks openai-compatible provider details and collects them into updates", () => {
    let state = createWizardState("configure", "/repo", baseConfig);
    state = answerCurrentStep(state, "");                       // graphStore -> sqlite
    state = answerCurrentStep(state, "memory");                 // semanticStore
    state = answerCurrentStep(state, "openai-compatible");      // provider
    expect(currentStep(state)?.key).toBe("embeddingBaseUrl");
    state = answerCurrentStep(state, "https://embed.example/v1");
    state = answerCurrentStep(state, "custom-embed");           // model
    state = answerCurrentStep(state, "sk-test");                // api key
    state = answerCurrentStep(state, "256");                    // dimensions
    state = answerCurrentStep(state, "yes");                    // request dimensions
    state = answerCurrentStep(state, "no");                     // test embedding
    state = answerCurrentStep(state, "yes");                    // save
    state = answerCurrentStep(state, "");                       // index now (default no)
    state = answerCurrentStep(state, "");                       // setup mcp (default no)

    const result = wizardResult(state);
    expect(result?.updates).toEqual({
      graphStore: "sqlite",
      semanticStore: "memory",
      embeddingProvider: "openai-compatible",
      embeddingBaseUrl: "https://embed.example/v1",
      embeddingModel: "custom-embed",
      embeddingApiKey: "sk-test",
      embeddingDimensions: 256,
      embeddingRequestDimensions: true
    });
    expect(result?.actions.testEmbedding).toBe(false);
  });

  it("returns no result when cancelled so config stays unchanged", () => {
    let state = createWizardState("configure", "/repo", baseConfig);
    state = answerCurrentStep(state, "");
    state = cancelWizard(state);

    expect(wizardResult(state)).toBeUndefined();
  });

  it("defaults index-now and setup-mcp to yes in first_run mode", () => {
    const state = acceptDefaults(createWizardState("first_run", "/repo", baseConfig));

    expect(wizardResult(state)?.actions).toEqual({ testEmbedding: true, save: true, indexNow: true, setupMcp: true });
  });

  it("skips index/setup-mcp steps when the user declines saving", () => {
    let state = createWizardState("configure", "/repo", baseConfig);
    state = answerCurrentStep(state, "");    // graphStore
    state = answerCurrentStep(state, "");    // semanticStore
    state = answerCurrentStep(state, "");    // provider (deterministic)
    state = answerCurrentStep(state, "no");  // test embedding
    state = answerCurrentStep(state, "no");  // save -> index/setup-mcp skipped

    expect(state.done).toBe(true);
    expect(wizardResult(state)?.actions).toEqual({ testEmbedding: false, save: false, indexNow: false, setupMcp: false });
  });
});

describe("configure wizard ink rendering", () => {
  it("renders the first step and completes on default selections", async () => {
    let finished: WizardState | undefined;
    const { lastFrame, stdin } = render(
      <ConfigureApp
        initialState={createWizardState("configure", "/repo", baseConfig)}
        onFinish={(state) => {
          finished = state;
        }}
      />
    );

    expect(lastFrame()).toContain("RagCode Configure");
    expect(lastFrame()).toContain("Graph store");

    for (let presses = 0; presses < 7 && !finished; presses += 1) {
      stdin.write("\r");
      await tick();
    }

    expect(finished?.done).toBe(true);
    expect(wizardResult(finished!)?.actions.save).toBe(true);
  });

  it("cancels on escape", async () => {
    let finished: WizardState | undefined;
    const { stdin } = render(
      <ConfigureApp
        initialState={createWizardState("configure", "/repo", baseConfig)}
        onFinish={(state) => {
          finished = state;
        }}
      />
    );

    stdin.write("");
    await waitFor(() => finished !== undefined);

    expect(finished?.cancelled).toBe(true);
    expect(wizardResult(finished!)).toBeUndefined();
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor timed out");
    await tick(25);
  }
}

function tick(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
