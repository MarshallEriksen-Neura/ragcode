import fs from "node:fs";
import path from "node:path";
import type { GraphStore } from "../core/contracts.js";
import { InMemoryGraphStore } from "../graph/in-memory-graph-store.js";
import { SQLiteGraphStore } from "../graph/sqlite-graph-store.js";

export type GraphStoreKind = "memory" | "sqlite";

export interface GraphRuntimeConfig {
  graphStore: GraphStoreKind;
  sqlitePath: string;
}

export interface GraphRuntimeComponents {
  graphStore: GraphStore;
  config: GraphRuntimeConfig;
}

export function createGraphRuntimeFromEnv(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): GraphRuntimeComponents {
  const config = readGraphRuntimeConfig(env, cwd);
  if (config.graphStore === "memory") {
    return { graphStore: new InMemoryGraphStore(), config };
  }
  fs.mkdirSync(path.dirname(config.sqlitePath), { recursive: true });
  return { graphStore: new SQLiteGraphStore(config.sqlitePath), config };
}

export function readGraphRuntimeConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): GraphRuntimeConfig {
  const graphStore = enumValue(env.RAGCODE_GRAPH_STORE, ["memory", "sqlite"], "memory");
  return {
    graphStore,
    sqlitePath: env.RAGCODE_SQLITE_PATH ?? path.join(cwd, ".ragcode", "graph.sqlite")
  };
}

function enumValue<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid graph runtime value "${value}". Expected one of: ${allowed.join(", ")}.`);
}
