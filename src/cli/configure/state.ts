import type { RedactedRuntimeConfig } from "../../config/runtime-config.js";
import type { ConfigureUpdates } from "../configure.js";

// Pure wizard state machine for the Ink configure/init flow. No UI, no IO — the Ink app
// renders it and run.ts executes the collected actions, so tests drive this directly
// (test spec: "test the extracted controller/state machine rather than terminal rendering").

export type WizardMode = "configure" | "first_run";

export interface SelectOption {
  value: string;
  label: string;
}

export interface WizardStep {
  key: string;
  kind: "select" | "text" | "confirm";
  title: string;
  options?: SelectOption[];
  defaultValue: string;
  secret?: boolean;
  skip?: (answers: WizardAnswers) => boolean;
}

export type WizardAnswers = Record<string, string>;

export interface WizardState {
  mode: WizardMode;
  repoRoot: string;
  steps: WizardStep[];
  stepIndex: number;
  answers: WizardAnswers;
  done: boolean;
  cancelled: boolean;
}

export interface WizardActions {
  testEmbedding: boolean;
  save: boolean;
  indexNow: boolean;
  setupMcp: boolean;
}

export interface WizardResult {
  updates: ConfigureUpdates;
  actions: WizardActions;
}

export function createWizardState(mode: WizardMode, repoRoot: string, current: RedactedRuntimeConfig): WizardState {
  const steps: WizardStep[] = [
    {
      key: "graphStore",
      kind: "select",
      title: "Graph store",
      options: [
        { value: "sqlite", label: "sqlite (persistent, recommended)" },
        { value: "memory", label: "memory (ephemeral)" }
      ],
      defaultValue: current.graphStore
    },
    {
      key: "semanticStore",
      kind: "select",
      title: "Semantic store",
      options: [
        { value: "lancedb", label: "lancedb (persistent vectors, recommended)" },
        { value: "memory", label: "memory (ephemeral)" }
      ],
      defaultValue: current.semanticStore
    },
    {
      key: "embeddingProvider",
      kind: "select",
      title: "Embedding provider",
      options: [
        { value: "deterministic", label: "deterministic (offline, no API key)" },
        { value: "openai-compatible", label: "openai-compatible (better recall, needs API key)" }
      ],
      defaultValue: current.embeddingProvider
    },
    {
      key: "embeddingBaseUrl",
      kind: "text",
      title: "Embedding base URL",
      defaultValue: current.embeddingBaseUrl ?? "https://api.openai.com/v1",
      skip: (answers) => answers.embeddingProvider !== "openai-compatible"
    },
    {
      key: "embeddingModel",
      kind: "text",
      title: "Embedding model",
      defaultValue: current.embeddingModel ?? "text-embedding-3-small",
      skip: (answers) => answers.embeddingProvider !== "openai-compatible"
    },
    {
      key: "embeddingApiKey",
      kind: "text",
      title: current.embeddingApiKey === "set" ? "Embedding API key (Enter keeps existing)" : "Embedding API key",
      defaultValue: "",
      secret: true,
      skip: (answers) => answers.embeddingProvider !== "openai-compatible"
    },
    {
      key: "embeddingDimensions",
      kind: "text",
      title: "Embedding dimensions (empty = provider default)",
      defaultValue: current.embeddingDimensions !== undefined ? String(current.embeddingDimensions) : "",
      skip: (answers) => answers.embeddingProvider !== "openai-compatible"
    },
    {
      key: "embeddingRequestDimensions",
      kind: "confirm",
      title: "Send the dimensions parameter to the provider?",
      defaultValue: current.embeddingRequestDimensions ? "yes" : "no",
      skip: (answers) => answers.embeddingProvider !== "openai-compatible" || !answers.embeddingDimensions
    },
    {
      key: "testEmbedding",
      kind: "confirm",
      title: "Test the embedding provider now?",
      defaultValue: "yes"
    },
    {
      key: "save",
      kind: "confirm",
      title: "Save this configuration to .ragcode/config.json?",
      defaultValue: "yes"
    },
    {
      key: "indexNow",
      kind: "confirm",
      title: "Index the repository now?",
      defaultValue: mode === "first_run" ? "yes" : "no",
      skip: (answers) => answers.save !== "yes"
    },
    {
      key: "setupMcp",
      kind: "confirm",
      title: "Register the MCP server for your agent client now?",
      defaultValue: mode === "first_run" ? "yes" : "no",
      skip: (answers) => answers.save !== "yes"
    }
  ];

  return {
    mode,
    repoRoot,
    steps,
    stepIndex: firstActiveStep(steps, {}, 0),
    answers: {},
    done: false,
    cancelled: false
  };
}

export function currentStep(state: WizardState): WizardStep | undefined {
  return state.done || state.cancelled ? undefined : state.steps[state.stepIndex];
}

// Records the answer for the current step and advances past any steps whose skip()
// predicate now holds. An empty answer falls back to the step's default.
export function answerCurrentStep(state: WizardState, rawValue: string): WizardState {
  const step = currentStep(state);
  if (!step) return state;
  const value = rawValue.trim() === "" ? step.defaultValue : rawValue.trim();
  const answers = { ...state.answers, [step.key]: value };
  const nextIndex = firstActiveStep(state.steps, answers, state.stepIndex + 1);
  return {
    ...state,
    answers,
    stepIndex: nextIndex,
    done: nextIndex >= state.steps.length
  };
}

export function cancelWizard(state: WizardState): WizardState {
  return { ...state, cancelled: true };
}

export function wizardResult(state: WizardState): WizardResult | undefined {
  if (!state.done || state.cancelled) return undefined;
  const answers = state.answers;
  const updates: ConfigureUpdates = {
    graphStore: answers.graphStore,
    semanticStore: answers.semanticStore,
    embeddingProvider: answers.embeddingProvider
  };
  if (answers.embeddingProvider === "openai-compatible") {
    if (answers.embeddingBaseUrl) updates.embeddingBaseUrl = answers.embeddingBaseUrl;
    if (answers.embeddingModel) updates.embeddingModel = answers.embeddingModel;
    if (answers.embeddingApiKey) updates.embeddingApiKey = answers.embeddingApiKey;
    if (answers.embeddingDimensions) updates.embeddingDimensions = Number(answers.embeddingDimensions);
    if (answers.embeddingRequestDimensions) updates.embeddingRequestDimensions = answers.embeddingRequestDimensions === "yes";
  }
  return {
    updates,
    actions: {
      testEmbedding: answers.testEmbedding === "yes",
      save: answers.save === "yes",
      indexNow: answers.indexNow === "yes",
      setupMcp: answers.setupMcp === "yes"
    }
  };
}

function firstActiveStep(steps: WizardStep[], answers: WizardAnswers, from: number): number {
  let index = from;
  while (index < steps.length && steps[index]!.skip?.(answers)) index += 1;
  return index;
}
