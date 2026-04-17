import { describe, it, expect, vi } from "vitest";
import {
  handleGetFileOverview,
  type GetFileOverviewDeps,
} from "../../src/tools/get-file-overview.js";

const mockOverview = {
  repo: "acme/backend",
  commit_sha: "abc1234567890",
  file_path: "src/main/java/com/example/OrderService.java",
  total: 3,
  symbols: [
    {
      scip_symbol: "scip-java OrderService#.",
      display_name: "OrderService",
      kind: "class",
      language: "java",
      start_line: 1,
      start_col: 0,
      end_line: 1,
      end_col: 12,
      signature: null,
      doc: null,
    },
    {
      scip_symbol: "scip-java OrderService#placeOrder().",
      display_name: "placeOrder",
      kind: "method",
      language: "java",
      start_line: 10,
      start_col: 2,
      end_line: 10,
      end_col: 12,
      signature: null,
      doc: "Places an order",
    },
    {
      scip_symbol: "scip-java OrderService#cancelOrder().",
      display_name: "cancelOrder",
      kind: "method",
      language: "java",
      start_line: 25,
      start_col: 2,
      end_line: 25,
      end_col: 13,
      signature: null,
      doc: null,
    },
  ],
};

const mockDeps: GetFileOverviewDeps = {
  getFileOverview: async () => mockOverview,
};

describe("handleGetFileOverview", () => {
  it("returns a single text content block", async () => {
    const result = await handleGetFileOverview(mockDeps, {
      repo: "acme/backend",
      file_path: "src/main/java/com/example/OrderService.java",
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
  });

  it("includes repo, file path, and symbol count in output", async () => {
    const result = await handleGetFileOverview(mockDeps, {
      repo: "acme/backend",
      file_path: "src/main/java/com/example/OrderService.java",
    });
    const text = result.content[0]!.text;
    expect(text).toContain("acme/backend");
    expect(text).toContain("OrderService.java");
    expect(text).toContain("3");
  });

  it("lists each symbol with line number, kind, and name", async () => {
    const result = await handleGetFileOverview(mockDeps, {
      repo: "acme/backend",
      file_path: "src/main/java/com/example/OrderService.java",
    });
    const text = result.content[0]!.text;
    expect(text).toContain("OrderService");
    expect(text).toContain("placeOrder");
    expect(text).toContain("class");
    expect(text).toContain("method");
    expect(text).toContain("10"); // line number
  });

  it("returns not-found message when result is null", async () => {
    const notFoundDeps: GetFileOverviewDeps = {
      getFileOverview: async () => null,
    };
    const result = await handleGetFileOverview(notFoundDeps, {
      repo: "acme/backend",
      file_path: "src/Nonexistent.java",
    });
    expect(result.content[0]!.text).toContain("No symbols indexed");
    expect(result.content[0]!.text).toContain("Nonexistent.java");
  });

  it("passes branch param to getFileOverview", async () => {
    const getFileOverview = vi.fn().mockResolvedValue(null);
    await handleGetFileOverview({ getFileOverview }, {
      repo: "myorg/myapp",
      file_path: "src/Foo.java",
      branch: "feature",
    });
    expect(getFileOverview).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "feature" })
    );
  });

  it("passes repo, file_path, and commit to client", async () => {
    let capturedRepo = "";
    let capturedFile = "";
    let capturedCommit: string | undefined;
    const captureDeps: GetFileOverviewDeps = {
      getFileOverview: async (params) => {
        capturedRepo = params.repo;
        capturedFile = params.file_path;
        capturedCommit = params.commit;
        return null;
      },
    };
    await handleGetFileOverview(captureDeps, {
      repo: "acme/backend",
      file_path: "src/Foo.java",
      commit: "deadbeef",
    });
    expect(capturedRepo).toBe("acme/backend");
    expect(capturedFile).toBe("src/Foo.java");
    expect(capturedCommit).toBe("deadbeef");
  });
});
