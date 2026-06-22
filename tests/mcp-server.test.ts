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

  it("steers agents toward proactive repo-context tools", () => {
    const descriptions = Object.fromEntries(
      listRuntimeToolDefinitions().map((tool) => [tool.name, tool.description])
    );

    expect(descriptions.get_context).toContain("PRIMARY tool");
    expect(descriptions.get_context).toContain("before manual grep/file reads");
    expect(descriptions.find_owner).toContain("Use early");
    expect(descriptions.find_reuse_candidates).toContain("Use proactively");
    expect(descriptions.trace_request_flow).toContain("runtime ownership");
  });
});

function createNoopEngine(): ContextEngine {
  const handler = async (): Promise<unknown> => ({ ok: true });
  return new Proxy({}, {
    get: () => handler
  }) as ContextEngine;
}
