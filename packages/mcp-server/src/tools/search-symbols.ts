import type { SearchParams, SymbolResult } from "../client.js";

export interface SearchSymbolsDeps {
  searchSymbols(params: SearchParams): Promise<{ results: SymbolResult[]; total: number }>;
}

export interface SearchSymbolsArgs {
  query: string;
  repo?: string;
  language?: string;
  kind?: string;
  limit?: number;
}

export async function handleSearchSymbols(
  deps: SearchSymbolsDeps,
  args: SearchSymbolsArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const { results } = await deps.searchSymbols({
    q: args.query,
    ...(args.repo !== undefined ? { repo: args.repo } : {}),
    ...(args.language !== undefined ? { lang: args.language } : {}),
    ...(args.kind !== undefined ? { kind: args.kind } : {}),
    limit: args.limit ?? 30,
  });

  if (results.length === 0) {
    return { content: [{ type: "text", text: "No symbols found." }] };
  }

  const lines = results.map(s => {
    const kind = s.kind ? `[${s.kind}]` : "[symbol]";
    const name = s.display_name ?? s.scip_symbol;
    const file = s.file_path.split("/").pop() ?? s.file_path;
    const lineNo = s.start_line != null ? `:${s.start_line}` : "";
    return [
      `${kind} ${name} — ${s.scip_symbol}`,
      `  repo: ${s.repo}@${s.commit_sha.slice(0, 8)}`,
      `  file: ${s.file_path}${lineNo}`,
    ].join("\n");
  });

  return { content: [{ type: "text", text: lines.join("\n\n") }] };
}
