import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
    version: options.version ?? "0.1.0"
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
  const engine = new RagCodeEngine({
    ...options,
    env: persistentDefaultEnv(options.env)
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

function persistentDefaultEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (env.RAGCODE_GRAPH_STORE) return env;
  return {
    ...env,
    RAGCODE_GRAPH_STORE: "sqlite"
  };
}
