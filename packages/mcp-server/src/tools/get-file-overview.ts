import type { FileOverviewParams, FileOverviewResult } from "../client.js";
import { shortSha } from "../format.js";

export interface GetFileOverviewDeps {
  getFileOverview(params: FileOverviewParams): Promise<FileOverviewResult | null>;
}

export interface GetFileOverviewArgs {
  repo: string;
  file_path: string;
  commit?: string;
}

export async function handleGetFileOverview(
  deps: GetFileOverviewDeps,
  args: GetFileOverviewArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const params: FileOverviewParams = {
    repo: args.repo,
    file_path: args.file_path,
  };
  if (args.commit !== undefined) params.commit = args.commit;

  const result = await deps.getFileOverview(params);

  const fileName = args.file_path.split("/").at(-1) ?? args.file_path;

  if (!result) {
    return {
      content: [
        {
          type: "text",
          text: `No symbols indexed in ${fileName}.`,
        },
      ],
    };
  }

  const header = [
    `File:    ${result.file_path}`,
    `Repo:    ${result.repo}@${shortSha(result.commit_sha)}`,
    `Symbols: ${result.total}`,
    ``,
  ].join("\n");

  const symLines =
    result.symbols.length === 0
      ? "  (none)"
      : result.symbols
          .map((s) => {
            const loc = s.start_line != null ? `${s.start_line}` : "?";
            const kind = s.kind ?? "unknown";
            const name = s.display_name ?? s.scip_symbol;
            return `  ${loc.padEnd(6)} ${kind.padEnd(10)} ${name}`;
          })
          .join("\n");

  return {
    content: [
      {
        type: "text",
        text: header + `Symbols:\n` + symLines,
      },
    ],
  };
}
