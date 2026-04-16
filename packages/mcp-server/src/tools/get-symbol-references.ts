import type { SymbolReferencesResult, SymbolReferencesParams } from "../client.js";
import { roleLabel, shortSha } from "../format.js";

export interface GetSymbolReferencesDeps {
  getSymbolReferences(
    scipSymbol: string,
    params?: SymbolReferencesParams
  ): Promise<SymbolReferencesResult | null>;
}

export interface GetSymbolReferencesArgs {
  scip_symbol: string;
  repo?: string;
  include_definitions?: boolean;
  limit?: number;
}

export async function handleGetSymbolReferences(
  deps: GetSymbolReferencesDeps,
  args: GetSymbolReferencesArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const params: SymbolReferencesParams = {};
  if (args.repo !== undefined) params.repo = args.repo;
  if (args.include_definitions !== undefined)
    params.include_definitions = args.include_definitions;
  if (args.limit !== undefined) params.limit = args.limit;

  const result = await deps.getSymbolReferences(args.scip_symbol, params);

  const displayName = args.scip_symbol.split(" ").at(-1) ?? args.scip_symbol;

  if (!result) {
    return {
      content: [
        {
          type: "text",
          text: `No references found for ${displayName}.`,
        },
      ],
    };
  }

  const header = [
    `Symbol:  ${result.scip_symbol}`,
    `Repo:    ${result.repo}@${shortSha(result.commit_sha)}`,
    `Total:   ${result.total}${result.truncated ? ` (showing first ${result.occurrences.length}, truncated)` : ""}`,
    ``,
  ].join("\n");

  const occLines =
    result.occurrences.length === 0
      ? "  (none)"
      : result.occurrences
          .map((o) => {
            const loc = o.start_line != null ? `:${o.start_line}` : "";
            return `  ${o.file_path}${loc}  (${roleLabel(o.role)})`;
          })
          .join("\n");

  return {
    content: [
      {
        type: "text",
        text: header + `References:\n` + occLines,
      },
    ],
  };
}
