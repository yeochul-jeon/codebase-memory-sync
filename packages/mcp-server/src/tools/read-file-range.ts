import type { FileRangeResult, FileRangeParams } from "../client.js";
import { shortSha } from "../format.js";

export interface ReadFileRangeDeps {
  readFileRange(params: FileRangeParams): Promise<FileRangeResult | null>;
}

export interface ReadFileRangeArgs {
  repo: string;
  file_path: string;
  start_line: number;
  end_line: number;
  commit?: string;
}

export async function handleReadFileRange(
  deps: ReadFileRangeDeps,
  args: ReadFileRangeArgs
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const params: { repo: string; file_path: string; start_line: number; end_line: number; commit?: string } = {
    repo: args.repo,
    file_path: args.file_path,
    start_line: args.start_line,
    end_line: args.end_line,
  };
  if (args.commit !== undefined) params.commit = args.commit;
  const result = await deps.readFileRange(params);

  if (!result) {
    return {
      content: [
        {
          type: "text",
          text: `File range not found: ${args.file_path} lines ${args.start_line}–${args.end_line} in ${args.repo}. Source may not be available for this commit.`,
        },
      ],
    };
  }

  const text = [
    `File:     ${result.file_path}:${result.start_line}–${result.end_line}`,
    `Repo:     ${result.repo}@${shortSha(result.commit_sha)}`,
    ``,
    "```",
    result.content,
    "```",
  ].join("\n");

  return { content: [{ type: "text", text }] };
}
