import type { DependenciesResult, RelationshipQueryParams } from "../client.js";
import { shortSha } from "../format.js";

export interface GetDependenciesDeps {
  getDependencies(
    scipSymbol: string,
    params?: RelationshipQueryParams
  ): Promise<DependenciesResult | null>;
}

export interface GetDependenciesArgs {
  scip_symbol: string;
  repo?: string;
  limit?: number;
}

function displayName(scipSymbol: string): string {
  return scipSymbol.split(" ").at(-1) ?? scipSymbol;
}

function relType(dep: {
  is_reference: boolean;
  is_implementation: boolean;
  is_type_definition: boolean;
  is_definition: boolean;
}): string {
  if (dep.is_implementation) return "implementation";
  if (dep.is_type_definition) return "type_definition";
  if (dep.is_reference) return "reference";
  if (dep.is_definition) return "definition";
  return "unknown";
}

export async function handleGetDependencies(
  deps: GetDependenciesDeps,
  args: GetDependenciesArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const params: RelationshipQueryParams = {};
  if (args.repo !== undefined) params.repo = args.repo;
  if (args.limit !== undefined) params.limit = args.limit;

  const result = await deps.getDependencies(args.scip_symbol, params);
  const name = displayName(args.scip_symbol);

  if (!result || result.total === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No dependencies found for ${name}.`,
        },
      ],
    };
  }

  const firstRepo = result.dependencies[0]?.repo ?? "";
  const firstSha = result.dependencies[0]?.commit_sha ?? "";

  const header = [
    `Dependencies of: ${args.scip_symbol}`,
    `Repo:  ${firstRepo}@${shortSha(firstSha)}`,
    `Total: ${result.total}`,
    ``,
    `Dependencies:`,
  ].join("\n");

  const lines = result.dependencies
    .map((dep) => {
      const depName = dep.display_name ?? dep.to_symbol;
      const kind = dep.kind ?? "unknown";
      const loc =
        dep.file_path
          ? `${dep.file_path}${dep.start_line != null ? `:${dep.start_line}` : ""}`
          : "?";
      const rel = relType(dep);
      return `  ${depName}  (${kind})  ${loc}  [${rel}]`;
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
