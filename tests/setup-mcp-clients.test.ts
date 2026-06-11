import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import {
  getClaudeCodeMCPConfigPath,
  getCodexConfigPath,
  mergeCodexToml,
  mergeMcpServersJson
} from "../scripts/setup-mcp.js";

const SERVER = {
  command: "ragcode",
  args: ["mcp"],
  cwd: "/repo",
  env: { RAGCODE_EMBEDDING_PROVIDER: "deterministic" }
};

describe("mergeMcpServersJson", () => {
  it("upserts ragcode while preserving other servers and unrelated keys", () => {
    const existing = {
      mcpServers: {
        other: { command: "other-tool", args: ["serve"] }
      },
      // an unrelated top-level key some clients keep
      theme: "dark"
    };

    const result = mergeMcpServersJson(existing, SERVER);

    expect(result.mcpServers.ragcode).toEqual(SERVER);
    expect(result.mcpServers.other).toEqual({ command: "other-tool", args: ["serve"] });
    expect((result as Record<string, unknown>).theme).toBe("dark");
  });

  it("overwrites an existing ragcode entry rather than duplicating it", () => {
    const existing = {
      mcpServers: { ragcode: { command: "stale", args: [] } }
    };

    const result = mergeMcpServersJson(existing, SERVER);

    expect(result.mcpServers.ragcode).toEqual(SERVER);
    expect(Object.keys(result.mcpServers)).toEqual(["ragcode"]);
  });

  it("starts from an empty config when existing is not an object", () => {
    const result = mergeMcpServersJson(undefined, SERVER);
    expect(result.mcpServers.ragcode).toEqual(SERVER);
  });

  it("does not mutate the input object", () => {
    const existing = { mcpServers: { other: { command: "x", args: [] } } };
    const snapshot = JSON.stringify(existing);
    mergeMcpServersJson(existing, SERVER);
    expect(JSON.stringify(existing)).toBe(snapshot);
  });
});

describe("mergeCodexToml", () => {
  it("upserts mcp_servers.ragcode while preserving other tables", () => {
    const existing = [
      'model = "o4-mini"',
      "",
      "[mcp_servers.other]",
      'command = "other-tool"',
      'args = ["serve"]',
      ""
    ].join("\n");

    const merged = mergeCodexToml(existing, SERVER);
    const parsed = parseToml(merged) as {
      model?: string;
      mcp_servers?: Record<string, { command?: string; args?: string[]; cwd?: string; env?: Record<string, string> }>;
    };

    expect(parsed.model).toBe("o4-mini");
    expect(parsed.mcp_servers?.other).toEqual({ command: "other-tool", args: ["serve"] });
    expect(parsed.mcp_servers?.ragcode).toMatchObject({
      command: "ragcode",
      args: ["mcp"],
      cwd: "/repo",
      env: { RAGCODE_EMBEDDING_PROVIDER: "deterministic" }
    });
  });

  it("produces valid TOML from an empty starting point", () => {
    const merged = mergeCodexToml("", SERVER);
    const parsed = parseToml(merged) as { mcp_servers?: Record<string, unknown> };
    expect(parsed.mcp_servers?.ragcode).toBeDefined();
  });

  it("overwrites an existing ragcode entry instead of duplicating it", () => {
    const existing = [
      "[mcp_servers.ragcode]",
      'command = "stale"',
      "args = []"
    ].join("\n");

    const merged = mergeCodexToml(existing, SERVER);
    const parsed = parseToml(merged) as {
      mcp_servers?: Record<string, { command?: string }>;
    };

    expect(parsed.mcp_servers?.ragcode?.command).toBe("ragcode");
    expect(Object.keys(parsed.mcp_servers ?? {})).toEqual(["ragcode"]);
  });

  it("omits cwd and env when they are absent", () => {
    const merged = mergeCodexToml("", { command: "ragcode", args: ["mcp"] });
    const parsed = parseToml(merged) as {
      mcp_servers?: Record<string, Record<string, unknown>>;
    };
    const entry = parsed.mcp_servers?.ragcode ?? {};
    expect("cwd" in entry).toBe(false);
    expect("env" in entry).toBe(false);
  });
});

describe("config path resolution", () => {
  it("resolves Claude Code config to <cwd>/.mcp.json", () => {
    expect(getClaudeCodeMCPConfigPath("/repo")).toBe(path.join("/repo", ".mcp.json"));
  });

  it("honors CODEX_HOME for the codex config path", () => {
    expect(getCodexConfigPath({ CODEX_HOME: "/custom/codex" })).toBe(
      path.join("/custom/codex", "config.toml")
    );
  });

  it("falls back to ~/.codex/config.toml when CODEX_HOME is unset", () => {
    expect(getCodexConfigPath({})).toBe(path.join(os.homedir(), ".codex", "config.toml"));
  });
});
