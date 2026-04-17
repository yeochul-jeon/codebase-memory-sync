import { describe, it, expect, vi } from "vitest";
import { handleReadFileRange } from "../../src/tools/read-file-range.js";
import type { ReadFileRangeDeps } from "../../src/tools/read-file-range.js";

const MOCK_RESULT = {
  repo: "myorg/myapp",
  commit_sha: "abc123def456",
  file_path: "src/Foo.java",
  start_line: 1,
  end_line: 5,
  content: "package com.example;\n\npublic class Foo {\n    private int x;\n",
};

describe("handleReadFileRange", () => {
  it("returns formatted file content for a valid request", async () => {
    const deps: ReadFileRangeDeps = {
      readFileRange: vi.fn().mockResolvedValue(MOCK_RESULT),
    };
    const result = await handleReadFileRange(deps, {
      repo: "myorg/myapp",
      file_path: "src/Foo.java",
      start_line: 1,
      end_line: 5,
    });
    expect(result.content[0]?.text).toContain("src/Foo.java");
    expect(result.content[0]?.text).toContain("package com.example");
  });

  it("includes line range in output", async () => {
    const deps: ReadFileRangeDeps = {
      readFileRange: vi.fn().mockResolvedValue(MOCK_RESULT),
    };
    const result = await handleReadFileRange(deps, {
      repo: "myorg/myapp",
      file_path: "src/Foo.java",
      start_line: 1,
      end_line: 5,
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("1");
    expect(text).toContain("5");
  });

  it("returns not-found message when file range returns null", async () => {
    const deps: ReadFileRangeDeps = {
      readFileRange: vi.fn().mockResolvedValue(null),
    };
    const result = await handleReadFileRange(deps, {
      repo: "myorg/myapp",
      file_path: "src/Missing.java",
      start_line: 1,
      end_line: 5,
    });
    expect(result.content[0]?.text).toContain("not found");
  });

  it("includes commit_sha (short) in output", async () => {
    const deps: ReadFileRangeDeps = {
      readFileRange: vi.fn().mockResolvedValue(MOCK_RESULT),
    };
    const result = await handleReadFileRange(deps, {
      repo: "myorg/myapp",
      file_path: "src/Foo.java",
      start_line: 1,
      end_line: 5,
    });
    // shortSha = first 8 chars of abc123def456
    expect(result.content[0]?.text).toContain("abc123de");
  });

  it("passes commit param through to client when provided", async () => {
    const mockFn = vi.fn().mockResolvedValue(MOCK_RESULT);
    const deps: ReadFileRangeDeps = { readFileRange: mockFn };
    await handleReadFileRange(deps, {
      repo: "myorg/myapp",
      file_path: "src/Foo.java",
      start_line: 1,
      end_line: 5,
      commit: "deadbeef",
    });
    expect(mockFn).toHaveBeenCalledWith(
      expect.objectContaining({ commit: "deadbeef" })
    );
  });
});
