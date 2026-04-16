import type { ImplementorsResult, RelationshipQueryParams } from "../client.js";
import { shortSha } from "../format.js";

export interface FindImplementorsDeps {
  findImplementors(
    scipSymbol: string,
    params?: RelationshipQueryParams
  ): Promise<ImplementorsResult | null>;
}

export interface FindImplementorsArgs {
  scip_symbol: string;
  repo?: string;
  limit?: number;
}

function displayName(scipSymbol: string): string {
  return scipSymbol.split(" ").at(-1) ?? scipSymbol;
}

export async function handleFindImplementors(
  deps: FindImplementorsDeps,
  args: FindImplementorsArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const params: RelationshipQueryParams = {};
  if (args.repo !== undefined) params.repo = args.repo;
  if (args.limit !== undefined) params.limit = args.limit;

  const result = await deps.findImplementors(args.scip_symbol, params);
  const name = displayName(args.scip_symbol);

  if (!result || result.total === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No implementors found for ${name}.`,
        },
      ],
    };
  }

  const firstRepo = result.implementors[0]?.repo ?? "";
  const firstSha = result.implementors[0]?.commit_sha ?? "";

  const truncNote =
    result.truncated ? ` (showing first ${result.implementors.length})` : "";

  const header = [
    `Implementors of: ${args.scip_symbol}`,
    `Repo:  ${firstRepo}@${shortSha(firstSha)}`,
    `Total: ${result.total}${truncNote}`,
    ``,
    `Implementors:`,
  ].join("\n");

  const lines = result.implementors
    .map((impl) => {
      const name2 = impl.display_name ?? impl.from_symbol;
      const kind = impl.kind ?? "unknown";
      const loc =
        impl.file_path
          ? `${impl.file_path}${impl.start_line != null ? `:${impl.start_line}` : ""}`
          : "?";
      return `  ${name2}  (${kind})  ${loc}`;
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
