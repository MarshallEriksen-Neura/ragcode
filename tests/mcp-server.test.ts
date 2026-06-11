import { describe, expect, it } from "vitest";
import type { ContextEngine } from "../src/index.js";
import { createMcpServer, listRuntimeToolDefinitions, listToolDefinitions } from "../src/index.js";

describe("MCP server", () => {
  it("builds a stdio-compatible server with the full tool registry", () => {
    const server = createMcpServer(createNoopEngine());
    const runtimeTools = listRuntimeToolDefinitions();

    expect(server.isConnected()).toBe(false);
    expect(runtimeTools.map((tool) => tool.name)).toEqual(listToolDefinitions().map((tool) => tool.name));
    expect(runtimeTools).toHaveLength(19);
  });
});

function createNoopEngine(): ContextEngine {
  const handler = async (): Promise<unknown> => ({ ok: true });
  return new Proxy({}, {
    get: () => handler
  }) as ContextEngine;
}
