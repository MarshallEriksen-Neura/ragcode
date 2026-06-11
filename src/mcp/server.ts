import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getPackageVersion } from "../config/package-info.js";
import { createRuntimeComponentsForRepo } from "../config/runtime-config.js";
import type { ContextEngine } from "../core/contracts.js";
import { RagCodeEngine, type RagCodeEngineOptions } from "../core/engine.js";
import { callTool, listRuntimeToolDefinitions } from "./tools.js";

export interface McpServerOptions {
  name?: string;
  version?: string;
}

export interface StdioMcpServerOptions extends McpServerOptions, RagCodeEngineOptions {}

export function createMcpServer(engine: ContextEngine, options: McpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: options.name ?? "ragcode-context-engine",
    version: options.version ?? getPackageVersion()
  });

  for (const tool of listRuntimeToolDefinitions()) {
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      },
      async (args) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(await callTool(engine, tool.name, args), null, 2)
          }
        ]
      })
    );
  }

  return server;
}

export async function startStdioMcpServer(options: StdioMcpServerOptions = {}): Promise<void> {
  // Entry points resolve runtime config through the shared loader (CLI args > env >
  // .ragcode/config.json > offline-first defaults). The engine constructor itself stays
  // env-driven so embedded/library/test usage keeps its lightweight in-memory defaults.
  const components = (options.graphStore && options.semanticStore && options.embeddingProvider)
    ? undefined
    : createRuntimeComponentsForRepo({ cwd: options.cwd, env: options.env });
  const engine = new RagCodeEngine({
    ...options,
    graphStore: options.graphStore ?? components?.graphStore,
    semanticStore: options.semanticStore ?? components?.semanticStore,
    embeddingProvider: options.embeddingProvider ?? components?.embeddingProvider
  });
  const server = createMcpServer(engine, options);
  const transport = new StdioServerTransport();
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await server.close();
    } finally {
      engine.close();
    }
  };

  process.once("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });
  process.once("exit", () => {
    engine.close();
  });

  await server.connect(transport);
}
