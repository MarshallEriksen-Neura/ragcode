import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RagCodeEngine, SQLiteGraphStore } from "../src/index.js";

let tempRoot: string;
const openStores: SQLiteGraphStore[] = [];

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ragcode-symbol-aware-"));
  await writeVitePluginFixture(tempRoot);
});

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("symbol-aware retrieval", () => {
  it("expands natural-language tokens to camelCase symbols and keeps implementation owners ahead", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    for (const mode of ["feature", "refactor", "explain"] as const) {
      const hits = await engine.searchCode({
        repoRoot: tempRoot,
        query: "resolve plugins build hooks",
        mode,
        limit: 12
      });
      assertImplementationOwnersLeadSupportingEvidence(hits);
    }

    const hits = await engine.searchCode({
      repoRoot: tempRoot,
      query: "resolve plugins build hooks",
      mode: "feature",
      limit: 12
    });
    const files = hits.map((hit) => hit.chunk.filePath);

    expect(hits.every((hit) => hit.scoreBreakdown?.final === hit.score)).toBe(true);
    expect(indexOf(files, "packages/vite/src/node/plugins/index.ts")).toBeLessThan(indexOf(files, "packages/vite/src/node/plugins/__tests__/resolve.spec.ts"));
    expect(indexOf(files, "packages/vite/src/node/build.ts")).toBeLessThan(indexOf(files, "docs/plugins.md"));
    expect(hits.find((hit) => hit.chunk.filePath === "packages/vite/src/node/plugins/index.ts")?.reason)
      .toContain("symbol expansion matched resolvePlugins");
    expect(hits.find((hit) => hit.chunk.filePath === "packages/vite/src/node/build.ts")?.reason)
      .toContain("symbol expansion matched resolveBuildPlugins");

    const pack = await engine.getContext({
      repoRoot: tempRoot,
      query: "resolve plugins build hooks",
      mode: "feature",
      budgetChars: 12_000
    });
    const ownerFiles = pack.ownerChain.map((owner) => owner.filePath);

    expect(ownerFiles.slice(0, 3)).toContain("packages/vite/src/node/plugins/index.ts");
    expect(ownerFiles.slice(0, 4)).toContain("packages/vite/src/node/build.ts");
    expect(pack.snippets.filter((snippet) => snippet.filePath === "packages/vite/src/node/plugins/__tests__/resolve.spec.ts").length).toBeLessThanOrEqual(1);
  });

  it("uses the same symbol expansion path with SQLite FTS", async () => {
    const dbDir = path.join(tempRoot, ".ragcode-test");
    await fs.mkdir(dbDir, { recursive: true });
    const store = new SQLiteGraphStore(path.join(dbDir, "graph.sqlite"));
    openStores.push(store);
    const engine = new RagCodeEngine({ graphStore: store });
    await engine.indexRepo(tempRoot);

    const hits = await engine.searchCode({
      repoRoot: tempRoot,
      query: "resolve plugins build hooks",
      mode: "feature",
      limit: 12
    });
    const files = hits.map((hit) => hit.chunk.filePath);

    expect(files).toContain("packages/vite/src/node/plugins/index.ts");
    expect(files).toContain("packages/vite/src/node/build.ts");
    expect(indexOf(files, "packages/vite/src/node/plugins/index.ts")).toBeLessThan(indexOf(files, "packages/vite/src/node/plugins/__tests__/resolve.spec.ts"));
  });

  it("keeps test-heavy files behind implementation owners for default owner queries", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const owners = await engine.findOwner(tempRoot, "resolve plugins build hooks", 6);
    const files = owners.map((owner) => owner.filePath);

    expect(files[0]).toBe("packages/vite/src/node/plugins/index.ts");
    expect(indexOf(files, "packages/vite/src/node/plugins/index.ts")).toBeLessThan(indexOf(files, "packages/vite/src/node/plugins/__tests__/resolve.spec.ts"));
    expect(owners.find((owner) => owner.filePath === "packages/vite/src/node/plugins/__tests__/resolve.spec.ts")?.reasons)
      .toEqual(expect.arrayContaining([expect.stringContaining("test default demotion")]));
  });

  it("keeps exact identifier owners ahead of broad message symbol piles", async () => {
    await writeScratchBridgeFixture(tempRoot);
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const owners = await engine.findOwner(
      tempRoot,
      "Scratch AI assistant bridge ScratchEditor AIAssistantBubble useScratchBridge postMessage",
      6
    );
    const files = owners.map((owner) => owner.filePath);

    expect(files[0]).toBe("lobehub/src/features/ScratchEditor/index.tsx");
    expect(indexOf(files, "lobehub/src/features/ScratchEditor/index.tsx")).toBeLessThan(indexOf(files, "lobehub/packages/builtin-tool-message/src/types.ts"));
    expect(owners[0]?.reasons).toEqual(expect.arrayContaining([expect.stringContaining("exact identifier owner boost")]));
    expect(owners.find((owner) => owner.filePath === "lobehub/packages/builtin-tool-message/src/types.ts")?.reasons)
      .toEqual(expect.arrayContaining([expect.stringContaining("symbol pile normalization")]));
  });

  it("applies owner symbol normalization with SQLite FTS", async () => {
    await writeScratchBridgeFixture(tempRoot);
    const dbDir = path.join(tempRoot, ".ragcode-owner-symbols");
    await fs.mkdir(dbDir, { recursive: true });
    const store = new SQLiteGraphStore(path.join(dbDir, "graph.sqlite"));
    openStores.push(store);
    const engine = new RagCodeEngine({ graphStore: store });
    await engine.indexRepo(tempRoot);

    const owners = await engine.findOwner(
      tempRoot,
      "Scratch AI assistant bridge ScratchEditor AIAssistantBubble useScratchBridge postMessage",
      6
    );
    const files = owners.map((owner) => owner.filePath);

    expect(files[0]).toBe("lobehub/src/features/ScratchEditor/index.tsx");
    expect(indexOf(files, "lobehub/src/features/ScratchEditor/index.tsx")).toBeLessThan(indexOf(files, "lobehub/packages/builtin-tool-message/src/types.ts"));
  });

  it("keeps explicitly requested test owners eligible for the top owner result", async () => {
    const engine = new RagCodeEngine();
    await engine.indexRepo(tempRoot);

    const owners = await engine.findOwner(tempRoot, "resolve plugins build hooks spec", 6);

    expect(owners[0]?.filePath).toBe("packages/vite/src/node/plugins/__tests__/resolve.spec.ts");
    expect(owners[0]?.reasons).toEqual(expect.arrayContaining([expect.stringContaining("test relevance boost")]));
  });

  it("applies owner test-path intent with SQLite FTS", async () => {
    const dbDir = path.join(tempRoot, ".ragcode-owner-test");
    await fs.mkdir(dbDir, { recursive: true });
    const store = new SQLiteGraphStore(path.join(dbDir, "graph.sqlite"));
    openStores.push(store);
    const engine = new RagCodeEngine({ graphStore: store });
    await engine.indexRepo(tempRoot);

    const defaultOwners = await engine.findOwner(tempRoot, "resolve plugins build hooks", 6);
    const defaultFiles = defaultOwners.map((owner) => owner.filePath);
    expect(indexOf(defaultFiles, "packages/vite/src/node/plugins/index.ts")).toBeLessThan(indexOf(defaultFiles, "packages/vite/src/node/plugins/__tests__/resolve.spec.ts"));

    const testOwners = await engine.findOwner(tempRoot, "resolve plugins build hooks spec", 6);
    expect(testOwners[0]?.filePath).toBe("packages/vite/src/node/plugins/__tests__/resolve.spec.ts");
  });
});

function assertImplementationOwnersLeadSupportingEvidence(hits: Awaited<ReturnType<RagCodeEngine["searchCode"]>>): void {
  const files = hits.map((hit) => hit.chunk.filePath);
  expect(indexOf(files, "packages/vite/src/node/plugins/index.ts")).toBeLessThan(indexOf(files, "packages/vite/src/node/plugins/__tests__/resolve.spec.ts"));
  expect(indexOf(files, "packages/vite/src/node/build.ts")).toBeLessThan(indexOf(files, "docs/plugins.md"));
  expect(indexOf(files, "packages/vite/src/node/build.ts")).toBeLessThan(indexOf(files, "playground/plugins/fixture.ts"));
}

async function writeVitePluginFixture(root: string): Promise<void> {
  await writeFile(root, "packages/vite/src/node/plugins/index.ts", [
    "export interface Plugin {",
    "  name: string",
    "  buildStart?: () => void",
    "}",
    "",
    "export function resolvePlugins(inlinePlugins: Plugin[]) {",
    "  return inlinePlugins.filter((plugin) => plugin.name);",
    "}"
  ].join("\n"));
  await writeFile(root, "packages/vite/src/node/build.ts", [
    "import { type Plugin, resolvePlugins } from './plugins';",
    "",
    "export function resolveBuildPlugins(userPlugins: Plugin[]) {",
    "  const plugins = resolvePlugins(userPlugins);",
    "  return plugins.map((plugin) => plugin.buildStart).filter(Boolean);",
    "}"
  ].join("\n"));
  await writeFile(root, "packages/vite/src/node/plugins/__tests__/resolve.spec.ts", [
    "import { expect, it } from 'vitest';",
    "import { resolvePlugins } from '../index';",
    "",
    "const repeated = 'resolve plugins build hooks '.repeat(200);",
    "",
    "function resolvePluginsBuildHooksLocalOne() {",
    "  return repeated;",
    "}",
    "",
    "function resolvePluginsBuildHooksLocalTwo() {",
    "  return `${repeated} resolve plugins build hooks`;",
    "}",
    "",
    "function resolvePluginsBuildHooksLocalThree() {",
    "  return `${repeated} resolve plugins build hooks again`;",
    "}",
    "",
    "it('documents resolve plugins build hooks behavior', () => {",
    "  expect(resolvePluginsBuildHooksLocalOne()).toContain('resolve plugins build hooks');",
    "  expect(resolvePluginsBuildHooksLocalTwo()).toContain('resolve plugins build hooks');",
    "  expect(resolvePluginsBuildHooksLocalThree()).toContain('resolve plugins build hooks');",
    "  expect(resolvePlugins([{ name: 'fixture' }])).toHaveLength(1);",
    "});"
  ].join("\n"));
  await writeFile(root, "docs/plugins.md", "resolve plugins build hooks ".repeat(240));
  await writeFile(root, "playground/plugins/fixture.ts", "export const fixture = 'resolve plugins build hooks '.repeat(120);");
}

async function writeScratchBridgeFixture(root: string): Promise<void> {
  await writeFile(root, "lobehub/src/features/ScratchEditor/index.tsx", [
    "import { AIAssistantBubble } from './AIAssistantBubble';",
    "import { useScratchBridge } from './useScratchBridge';",
    "",
    "export function ScratchEditor() {",
    "  const bridge = useScratchBridge();",
    "  bridge.postMessage({ type: 'scratch-ai-assistant-bridge' });",
    "  return <AIAssistantBubble onGenerateBlocks={() => bridge.postMessage({ type: 'generate-blocks' })} />;",
    "}"
  ].join("\n"));
  await writeFile(root, "lobehub/src/features/ScratchEditor/AIAssistantBubble.tsx", [
    "export interface AIAssistantBubbleProps {",
    "  onGenerateBlocks: () => void;",
    "}",
    "",
    "export function AIAssistantBubble(props: AIAssistantBubbleProps) {",
    "  return <button onClick={props.onGenerateBlocks}>AI</button>;",
    "}"
  ].join("\n"));
  await writeFile(root, "lobehub/src/features/ScratchEditor/useScratchBridge.ts", [
    "export function useScratchBridge() {",
    "  return {",
    "    postMessage(message: unknown) {",
    "      window.postMessage(message, '*');",
    "    }",
    "  };",
    "}"
  ].join("\n"));

  const messageTypes = Array.from({ length: 80 }, (_, index) => [
    `export interface MessageBridgeAssistantState${index} {`,
    "  assistantMessage: string;",
    "  postMessage: string;",
    "}"
  ].join("\n")).join("\n\n");
  await writeFile(root, "lobehub/packages/builtin-tool-message/src/types.ts", [
    "export const MessageToolIdentifier = 'lobe-message';",
    "export interface MessagePlatform { assistant: string; postMessage: string; }",
    messageTypes
  ].join("\n\n"));
}

async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

function indexOf(files: string[], filePath: string): number {
  const index = files.indexOf(filePath);
  expect(index, `${filePath} was not returned`).toBeGreaterThanOrEqual(0);
  return index;
}
