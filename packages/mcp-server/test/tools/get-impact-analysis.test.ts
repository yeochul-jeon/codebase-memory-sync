import { describe, it, expect } from "vitest";
import {
  handleGetImpactAnalysis,
  type GetImpactAnalysisDeps,
} from "../../src/tools/get-impact-analysis.js";

const mockResult = {
  scip_symbol: "scip-java maven com.example:app 1.0 com/example/IFoo#.",
  depth: 3,
  total: 3,
  truncated: false,
  impacted: [
    {
      symbol: "scip-java maven com.example:app 1.0 com/example/FooImpl#.",
      display_name: "FooImpl",
      kind: "class",
      file_path: "src/FooImpl.java",
      start_line: 5,
      depth: 1,
      repo: "acme/backend",
      commit_sha: "abc1234567890",
    },
    {
      symbol: "scip-java maven com.example:app 1.0 com/example/FooService#.",
      display_name: "FooService",
      kind: "class",
      file_path: "src/FooService.java",
      start_line: 12,
      depth: 2,
      repo: "acme/backend",
      commit_sha: "abc1234567890",
    },
    {
      symbol: "scip-java maven com.example:app 1.0 com/example/FooController#.",
      display_name: "FooController",
      kind: "class",
      file_path: "src/FooController.java",
      start_line: 8,
      depth: 3,
      repo: "acme/backend",
      commit_sha: "abc1234567890",
    },
  ],
};

const mockDeps: GetImpactAnalysisDeps = {
  getImpactAnalysis: async () => mockResult,
};

describe("handleGetImpactAnalysis", () => {
  it("returns a single text content block", async () => {
    const result = await handleGetImpactAnalysis(mockDeps, {
      scip_symbol: mockResult.scip_symbol,
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
  });

  it("includes source symbol and total in output", async () => {
    const result = await handleGetImpactAnalysis(mockDeps, {
      scip_symbol: mockResult.scip_symbol,
    });
    const text = result.content[0]!.text;
    expect(text).toContain("IFoo");
    expect(text).toContain("3");
  });

  it("lists each impacted symbol with depth and location", async () => {
    const result = await handleGetImpactAnalysis(mockDeps, {
      scip_symbol: mockResult.scip_symbol,
    });
    const text = result.content[0]!.text;
    expect(text).toContain("FooImpl");
    expect(text).toContain("FooService");
    expect(text).toContain("FooController");
    expect(text).toContain("depth 1");
    expect(text).toContain("depth 2");
    expect(text).toContain("depth 3");
  });

  it("returns not-found message when result is null", async () => {
    const notFoundDeps: GetImpactAnalysisDeps = {
      getImpactAnalysis: async () => null,
    };
    const result = await handleGetImpactAnalysis(notFoundDeps, {
      scip_symbol: mockResult.scip_symbol,
    });
    expect(result.content[0]!.text).toContain("No dependents found");
    expect(result.content[0]!.text).toContain("IFoo");
  });

  it("passes scip_symbol, repo, depth, limit to client", async () => {
    let capturedSymbol = "";
    let capturedParams: Record<string, unknown> = {};
    const captureDeps: GetImpactAnalysisDeps = {
      getImpactAnalysis: async (sym, params) => {
        capturedSymbol = sym;
        capturedParams = params ?? {};
        return null;
      },
    };
    await handleGetImpactAnalysis(captureDeps, {
      scip_symbol: "test#.",
      repo: "org/repo",
      depth: 2,
      limit: 50,
    });
    expect(capturedSymbol).toBe("test#.");
    expect(capturedParams["repo"]).toBe("org/repo");
    expect(capturedParams["depth"]).toBe(2);
    expect(capturedParams["limit"]).toBe(50);
  });
});
