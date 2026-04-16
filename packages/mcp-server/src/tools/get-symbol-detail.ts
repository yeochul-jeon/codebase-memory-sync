import type { SymbolDetail } from "../client.js";
import { roleLabel } from "../format.js";

export interface GetSymbolDetailDeps {
  getSymbolDetail(scipSymbol: string): Promise<SymbolDetail | null>;
}

export interface GetSymbolDetailArgs {
  scip_symbol: string;
}

export async function handleGetSymbolDetail(
  deps: GetSymbolDetailDeps,
  args: GetSymbolDetailArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const detail = await deps.getSymbolDetail(args.scip_symbol);

  if (!detail) {
    return {
      content: [{ type: "text", text: `Symbol not found: ${args.scip_symbol}` }],
    };
  }

  const { symbol, repo, commit_sha, occurrences } = detail;
  const range =
    symbol.start_line != null
      ? symbol.end_line != null && symbol.end_line !== symbol.start_line
        ? `${symbol.start_line}–${symbol.end_line}`
        : `${symbol.start_line}`
      : "?";

  const occLines =
    occurrences.length === 0
      ? "  (none)"
      : occurrences
          .map(o => {
            const loc = o.start_line != null ? `:${o.start_line}` : "";
            return `  ${o.file_path}${loc}  (${roleLabel(o.role)})`;
          })
          .join("\n");

  const text = [
    `Symbol:   ${symbol.display_name ?? symbol.scip_symbol}`,
    `Kind:     ${symbol.kind ?? "unknown"}`,
    `SCIP:     ${symbol.scip_symbol}`,
    `repo:     ${repo}@${commit_sha.slice(0, 8)}`,
    `file:     ${symbol.file_path}:${range}`,
    `Lang:     ${symbol.language ?? "unknown"}`,
    ...(symbol.doc ? [`Doc:      ${symbol.doc}`] : []),
    `References (${occurrences.length}):`,
    occLines,
  ].join("\n");

  return { content: [{ type: "text", text }] };
}
