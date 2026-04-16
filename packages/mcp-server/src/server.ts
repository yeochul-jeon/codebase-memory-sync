import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CmsClient } from "./client.js";
import { handleListProjects } from "./tools/list-projects.js";
import { handleSearchSymbols } from "./tools/search-symbols.js";
import { handleGetSymbolDetail } from "./tools/get-symbol-detail.js";
import { handleGetSymbolReferences } from "./tools/get-symbol-references.js";
import { handleGetFileOverview } from "./tools/get-file-overview.js";

export function createMcpServer(cmsClient: CmsClient): McpServer {
  const server = new McpServer({
    name: "cms-mcp-server",
    version: "0.1.0",
  });

  // ── list_projects ────────────────────────────────────────────────────────────
  server.registerTool(
    "list_projects",
    {
      description:
        "List all indexed repositories with their latest committed heads and languages.",
    },
    async () => handleListProjects({ listRepos: () => cmsClient.listRepos() })
  );

  // ── search_symbols ───────────────────────────────────────────────────────────
  server.registerTool(
    "search_symbols",
    {
      description:
        "Search for symbols (classes, methods, fields, etc.) across all indexed repos.",
      inputSchema: {
        query: z.string().min(1).describe("Symbol name or prefix to search for"),
        repo: z.string().optional().describe("Filter by repo in 'org/name' format"),
        language: z.string().optional().describe("Filter by language (e.g. 'java', 'typescript')"),
        kind: z.string().optional().describe("Filter by kind (e.g. 'class', 'method', 'field')"),
        limit: z.number().int().positive().default(30).describe("Max results to return (default 30, max 200)"),
      },
    },
    async (args) =>
      handleSearchSymbols(
        { searchSymbols: (p) => cmsClient.searchSymbols(p) },
        {
          query: args.query,
          ...(args.repo !== undefined ? { repo: args.repo } : {}),
          ...(args.language !== undefined ? { language: args.language } : {}),
          ...(args.kind !== undefined ? { kind: args.kind } : {}),
          limit: args.limit,
        }
      )
  );

  // ── get_symbol_detail ────────────────────────────────────────────────────────
  server.registerTool(
    "get_symbol_detail",
    {
      description:
        "Get full details for a symbol by its canonical SCIP symbol string, including occurrences/references.",
      inputSchema: {
        scip_symbol: z
          .string()
          .min(1)
          .describe("Canonical SCIP symbol string (obtained from search_symbols output)"),
      },
    },
    async (args) =>
      handleGetSymbolDetail(
        { getSymbolDetail: (sym) => cmsClient.getSymbolDetail(sym) },
        { scip_symbol: args.scip_symbol }
      )
  );

  // ── get_file_overview ───────────────────────────────────────────────────────
  server.registerTool(
    "get_file_overview",
    {
      description:
        "List all symbols (classes, methods, fields, etc.) defined in a specific file.",
      inputSchema: {
        repo: z.string().min(1).describe("Repository in 'org/name' format"),
        file_path: z.string().min(1).describe("Relative file path within the repo"),
        commit: z.string().optional().describe("Specific commit SHA (defaults to latest indexed)"),
      },
    },
    async (args) =>
      handleGetFileOverview(
        {
          getFileOverview: (p) => cmsClient.getFileOverview(p),
        },
        {
          repo: args.repo,
          file_path: args.file_path,
          ...(args.commit !== undefined ? { commit: args.commit } : {}),
        }
      )
  );

  // ── get_symbol_references ────────────────────────────────────────────────────
  server.registerTool(
    "get_symbol_references",
    {
      description:
        "Get all references (usages) of a symbol by its canonical SCIP symbol string.",
      inputSchema: {
        scip_symbol: z
          .string()
          .min(1)
          .describe("Canonical SCIP symbol string (obtained from search_symbols output)"),
        repo: z.string().optional().describe("Filter by repo in 'org/name' format"),
        include_definitions: z
          .boolean()
          .optional()
          .describe("Include definition occurrences (default false)"),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .default(100)
          .describe("Max references to return (default 100, max 500)"),
      },
    },
    async (args) =>
      handleGetSymbolReferences(
        {
          getSymbolReferences: (sym, p) => cmsClient.getSymbolReferences(sym, p),
        },
        {
          scip_symbol: args.scip_symbol,
          ...(args.repo !== undefined ? { repo: args.repo } : {}),
          ...(args.include_definitions !== undefined
            ? { include_definitions: args.include_definitions }
            : {}),
          limit: args.limit,
        }
      )
  );

  return server;
}
