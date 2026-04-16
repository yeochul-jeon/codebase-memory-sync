/**
 * Integration test: spawns the MCP server via stdio transport and exercises
 * all 3 tools using the real MCP Client SDK.
 *
 * Requires core-service running at CMS_ENDPOINT (default: http://localhost:3000).
 * Skips gracefully when core-service is unreachable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_TS = join(__dirname, "../src/index.ts");
const TSX = join(__dirname, "../node_modules/.bin/tsx");

const CMS_ENDPOINT = process.env["CMS_ENDPOINT"] ?? "http://localhost:3000";

let client: Client;
let transport: StdioClientTransport;
let available = false;

beforeAll(async () => {
  // Quick reachability check
  try {
    const res = await fetch(`${CMS_ENDPOINT}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return;
    available = true;
  } catch {
    available = false;
    return;
  }

  transport = new StdioClientTransport({
    command: TSX,
    args: [INDEX_TS],
    env: { ...process.env, CMS_ENDPOINT },
  });

  client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(transport);
}, 15_000);

afterAll(async () => {
  if (client) {
    try { await client.close(); } catch {}
  }
});

describe("MCP server integration", () => {
  it("exposes expected tools including v1 + v2b additions", async () => {
    if (!available) { console.warn("Skipping — core-service not reachable"); return; }
    const tools = await client.listTools();
    const names = tools.tools.map(t => t.name);
    expect(names).toContain("list_projects");
    expect(names).toContain("search_symbols");
    expect(names).toContain("get_symbol_detail");
    expect(names).toContain("get_symbol_references");
    expect(names).toContain("get_file_overview");
    expect(names).toContain("find_implementors");
    expect(names).toContain("get_dependencies");
    expect(names).toContain("get_impact_analysis");
  });

  it("list_projects returns text content", async () => {
    if (!available) return;
    const result = await client.callTool({ name: "list_projects", arguments: {} });
    expect(result.content).toBeDefined();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content.length).toBeGreaterThanOrEqual(1);
    expect(content[0]!.type).toBe("text");
    expect(typeof content[0]!.text).toBe("string");
  });

  it("search_symbols with known query returns text content", async () => {
    if (!available) return;
    const result = await client.callTool({ name: "search_symbols", arguments: { query: "place" } });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.type).toBe("text");
    // Either results or "No symbols found." — both are valid text
    expect(typeof content[0]!.text).toBe("string");
    expect(content[0]!.text.length).toBeGreaterThan(0);
  });

  it("get_symbol_detail with unknown symbol returns not-found text", async () => {
    if (!available) return;
    const result = await client.callTool({
      name: "get_symbol_detail",
      arguments: { scip_symbol: "scip-unknown nonexistent symbol." },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.text).toContain("Symbol not found");
  });

  it("get_symbol_references with unknown symbol returns no-references text", async () => {
    if (!available) return;
    const result = await client.callTool({
      name: "get_symbol_references",
      arguments: { scip_symbol: "scip-unknown nonexistent symbol." },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).toContain("No references found");
  });

  it("get_file_overview with unknown file returns no-symbols text", async () => {
    if (!available) return;
    const result = await client.callTool({
      name: "get_file_overview",
      arguments: { repo: "nonexistent/repo", file_path: "src/unknown.ts" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.type).toBe("text");
    expect(typeof content[0]!.text).toBe("string");
  });

  it("find_implementors with unknown symbol returns no-implementors text", async () => {
    if (!available) return;
    const result = await client.callTool({
      name: "find_implementors",
      arguments: { scip_symbol: "scip-unknown nonexistent interface." },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).toContain("No implementors found");
  });

  it("get_dependencies with unknown symbol returns no-dependencies text", async () => {
    if (!available) return;
    const result = await client.callTool({
      name: "get_dependencies",
      arguments: { scip_symbol: "scip-unknown nonexistent symbol." },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).toContain("No dependencies found");
  });

  it("get_impact_analysis with unknown symbol returns no-dependents text", async () => {
    if (!available) return;
    const result = await client.callTool({
      name: "get_impact_analysis",
      arguments: { scip_symbol: "scip-unknown nonexistent symbol." },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).toContain("No dependents found");
  });
});
