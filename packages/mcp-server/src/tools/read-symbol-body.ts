import type { SymbolBodyResult } from "../client.js";
import { shortSha } from "../format.js";

export interface ReadSymbolBodyDeps {
  readSymbolBody(
    scipSymbol: string,
    opts?: { repo?: string; commit?: string }
  ): Promise<SymbolBodyResult | null>;
}

export interface ReadSymbolBodyArgs {
  scip_symbol: string;
  repo?: string;
  commit?: string;
}

export async function handleReadSymbolBody(
  deps: ReadSymbolBodyDeps,
  args: ReadSymbolBodyArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const opts: { repo?: string; commit?: string } = {};
  if (args.repo !== undefined) opts.repo = args.repo;
  if (args.commit !== undefined) opts.commit = args.commit;
  const result = await deps.readSymbolBody(args.scip_symbol, opts);

  if (!result) {
    return {
      content: [
        {
          type: "text",
          text: `Symbol source not found: ${args.scip_symbol}${args.repo ? ` in ${args.repo}` : ""}. Ensure the repo has a CI-produced index with source.zip.`,
        },
      ],
    };
  }

  const fallbackNote =
    result.body_source === "identifier_fallback"
      ? " [body_source: identifier_fallback — enclosing_range not available for this indexer]"
      : "";

  const text = [
    `Symbol:   ${args.scip_symbol}`,
    `File:     ${result.file_path}:${result.start_line}–${result.end_line}`,
    `Repo:     ${result.repo}@${shortSha(result.commit_sha)}${fallbackNote}`,
    ``,
    "```",
    result.content,
    "```",
  ].join("\n");

  return { content: [{ type: "text", text }] };
}
