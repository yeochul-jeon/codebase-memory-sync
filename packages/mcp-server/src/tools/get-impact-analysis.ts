import type { ImpactResult, ImpactQueryParams } from "../client.js";
import { shortSha } from "../format.js";

export interface GetImpactAnalysisDeps {
  getImpactAnalysis(
    scipSymbol: string,
    params?: ImpactQueryParams
  ): Promise<ImpactResult | null>;
}

export interface GetImpactAnalysisArgs {
  scip_symbol: string;
  repo?: string;
  depth?: number;
  limit?: number;
}

function displayName(scipSymbol: string): string {
  return scipSymbol.split(" ").at(-1) ?? scipSymbol;
}

export async function handleGetImpactAnalysis(
  deps: GetImpactAnalysisDeps,
  args: GetImpactAnalysisArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const params: ImpactQueryParams = {};
  if (args.repo !== undefined) params.repo = args.repo;
  if (args.depth !== undefined) params.depth = args.depth;
  if (args.limit !== undefined) params.limit = args.limit;

  const result = await deps.getImpactAnalysis(args.scip_symbol, params);
  const name = displayName(args.scip_symbol);

  if (!result || result.total === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No dependents found for ${name}. The symbol may not be in the relationship graph.`,
        },
      ],
    };
  }

  const firstRepo = result.impacted.find((x) => x.repo)?.repo ?? "";
  const firstSha = result.impacted.find((x) => x.commit_sha)?.commit_sha ?? "";

  const truncNote =
    result.truncated ? ` (showing first ${result.impacted.length})` : "";

  const header = [
    `Impact analysis for: ${args.scip_symbol}`,
    `Repo:  ${firstRepo}${firstSha ? `@${shortSha(firstSha)}` : ""}`,
    `Depth: ${result.depth}  Total impacted: ${result.total}${truncNote}`,
    ``,
    `Impacted symbols:`,
  ].join("\n");

  const lines = result.impacted
    .map((entry) => {
      const symName = entry.display_name ?? entry.symbol;
      const kind = entry.kind ?? "unknown";
      const loc =
        entry.file_path
          ? `${entry.file_path}${entry.start_line != null ? `:${entry.start_line}` : ""}`
          : "?";
      return `  ${symName}  (${kind})  ${loc}  [depth ${entry.depth}]`;
    })
    .join("\n");

  return {
    content: [
      {
        type: "text",
        text: header + "\n" + lines,
      },
    ],
  };
}
