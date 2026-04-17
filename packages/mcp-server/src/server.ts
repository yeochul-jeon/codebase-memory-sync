import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CmsClient } from "./client.js";
import { handleListProjects } from "./tools/list-projects.js";
import { handleSearchSymbols } from "./tools/search-symbols.js";
import { handleGetSymbolDetail } from "./tools/get-symbol-detail.js";
import { handleGetSymbolReferences } from "./tools/get-symbol-references.js";
import { handleGetFileOverview } from "./tools/get-file-overview.js";
import { handleFindImplementors } from "./tools/find-implementors.js";
import { handleGetDependencies } from "./tools/get-dependencies.js";
import { handleGetImpactAnalysis } from "./tools/get-impact-analysis.js";
import { handleReadSymbolBody } from "./tools/read-symbol-body.js";
import { handleReadFileRange } from "./tools/read-file-range.js";

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
        branch: z.string().optional().describe("Branch name (defaults to repo default_branch when commit is omitted)"),
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
          ...(args.branch !== undefined ? { branch: args.branch } : {}),
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

  // ── find_implementors ────────────────────────────────────────────────────────
  server.registerTool(
    "find_implementors",
    {
      description:
        "Find all concrete classes/types that implement or extend a given interface or abstract class.",
      inputSchema: {
        scip_symbol: z
          .string()
          .min(1)
          .describe("Canonical SCIP symbol string of the interface or abstract class"),
        repo: z.string().optional().describe("Filter by repo in 'org/name' format"),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .default(50)
          .describe("Max results to return (default 50, max 500)"),
      },
    },
    async (args) =>
      handleFindImplementors(
        { findImplementors: (sym, p) => cmsClient.findImplementors(sym, p) },
        {
          scip_symbol: args.scip_symbol,
          ...(args.repo !== undefined ? { repo: args.repo } : {}),
          limit: args.limit,
        }
      )
  );

  // ── get_dependencies ─────────────────────────────────────────────────────────
  server.registerTool(
    "get_dependencies",
    {
      description:
        "Get all symbols that a given symbol directly depends on (calls, imports, extends, implements).",
      inputSchema: {
        scip_symbol: z
          .string()
          .min(1)
          .describe("Canonical SCIP symbol string"),
        repo: z.string().optional().describe("Filter by repo in 'org/name' format"),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .default(50)
          .describe("Max results to return (default 50, max 500)"),
      },
    },
    async (args) =>
      handleGetDependencies(
        { getDependencies: (sym, p) => cmsClient.getDependencies(sym, p) },
        {
          scip_symbol: args.scip_symbol,
          ...(args.repo !== undefined ? { repo: args.repo } : {}),
          limit: args.limit,
        }
      )
  );

  // ── get_impact_analysis ──────────────────────────────────────────────────────
  server.registerTool(
    "get_impact_analysis",
    {
      description:
        "Find all symbols that transitively depend on the given symbol (reverse dependency / impact analysis). Use this to understand the blast radius of changing a symbol.",
      inputSchema: {
        scip_symbol: z
          .string()
          .min(1)
          .describe("Canonical SCIP symbol string"),
        repo: z.string().optional().describe("Filter by repo in 'org/name' format"),
        depth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .default(3)
          .describe("Max traversal depth (default 3, max 5)"),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .default(50)
          .describe("Max results to return (default 50, max 500)"),
      },
    },
    async (args) =>
      handleGetImpactAnalysis(
        { getImpactAnalysis: (sym, p) => cmsClient.getImpactAnalysis(sym, p) },
        {
          scip_symbol: args.scip_symbol,
          ...(args.repo !== undefined ? { repo: args.repo } : {}),
          depth: args.depth,
          limit: args.limit,
        }
      )
  );

  // ── read_symbol_body ─────────────────────────────────────────────────────────
  server.registerTool(
    "read_symbol_body",
    {
      description:
        "Read the source code body of a symbol (method, class, function). Returns the full source from the CI-uploaded source archive.",
      inputSchema: {
        scip_symbol: z
          .string()
          .min(1)
          .describe("Canonical SCIP symbol string (obtained from search_symbols or get_symbol_detail)"),
        repo: z.string().optional().describe("Filter by repo in 'org/name' format"),
        commit: z.string().optional().describe("Specific commit SHA (defaults to latest indexed)"),
        branch: z.string().optional().describe("Branch name (defaults to repo default_branch when commit is omitted)"),
      },
    },
    async (args) =>
      handleReadSymbolBody(
        { readSymbolBody: (sym, opts) => cmsClient.readSymbolBody(sym, opts) },
        {
          scip_symbol: args.scip_symbol,
          ...(args.repo !== undefined ? { repo: args.repo } : {}),
          ...(args.commit !== undefined ? { commit: args.commit } : {}),
          ...(args.branch !== undefined ? { branch: args.branch } : {}),
        }
      )
  );

  // ── read_file_range ──────────────────────────────────────────────────────────
  server.registerTool(
    "read_file_range",
    {
      description:
        "Read a range of lines from a source file. Returns raw source content from the CI-uploaded source archive.",
      inputSchema: {
        repo: z.string().min(1).describe("Repository in 'org/name' format"),
        file_path: z.string().min(1).describe("Relative file path within the repo"),
        start_line: z.number().int().min(1).describe("First line to read (1-indexed, inclusive)"),
        end_line: z.number().int().min(1).describe("Last line to read (1-indexed, inclusive)"),
        commit: z.string().optional().describe("Specific commit SHA (defaults to latest indexed)"),
        branch: z.string().optional().describe("Branch name (defaults to repo default_branch when commit is omitted)"),
      },
    },
    async (args) =>
      handleReadFileRange(
        { readFileRange: (p) => cmsClient.readFileRange(p) },
        {
          repo: args.repo,
          file_path: args.file_path,
          start_line: args.start_line,
          end_line: args.end_line,
          ...(args.commit !== undefined ? { commit: args.commit } : {}),
          ...(args.branch !== undefined ? { branch: args.branch } : {}),
        }
      )
  );

  return server;
}
