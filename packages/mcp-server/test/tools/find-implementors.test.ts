import { describe, it, expect } from "vitest";
import {
  handleFindImplementors,
  type FindImplementorsDeps,
} from "../../src/tools/find-implementors.js";

const mockResult = {
  scip_symbol:
    "scip-java maven com.example:app 1.0 com/example/IOrderService#.",
  total: 2,
  truncated: false,
  implementors: [
    {
      from_symbol:
        "scip-java maven com.example:app 1.0 com/example/OrderServiceImpl#.",
      display_name: "OrderServiceImpl",
      kind: "class",
      file_path: "src/OrderServiceImpl.java",
      start_line: 5,
      repo: "acme/backend",
      commit_sha: "abc1234567890",
    },
    {
      from_symbol:
        "scip-java maven com.example:app 1.0 com/example/MockOrderService#.",
      display_name: "MockOrderService",
      kind: "class",
      file_path: "test/MockOrderService.java",
      start_line: 10,
      repo: "acme/backend",
      commit_sha: "abc1234567890",
    },
  ],
};

const mockDeps: FindImplementorsDeps = {
  findImplementors: async () => mockResult,
};

describe("handleFindImplementors", () => {
  it("returns a single text content block", async () => {
    const result = await handleFindImplementors(mockDeps, {
      scip_symbol: mockResult.scip_symbol,
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
  });

  it("includes interface symbol and total in output", async () => {
    const result = await handleFindImplementors(mockDeps, {
      scip_symbol: mockResult.scip_symbol,
    });
    const text = result.content[0]!.text;
    expect(text).toContain("IOrderService");
    expect(text).toContain("2");
  });

  it("lists each implementor with display name, kind, file, and line", async () => {
    const result = await handleFindImplementors(mockDeps, {
      scip_symbol: mockResult.scip_symbol,
    });
    const text = result.content[0]!.text;
    expect(text).toContain("OrderServiceImpl");
    expect(text).toContain("class");
    expect(text).toContain("src/OrderServiceImpl.java");
    expect(text).toContain("5");
    expect(text).toContain("MockOrderService");
  });

  it("returns not-found message when result is null", async () => {
    const notFoundDeps: FindImplementorsDeps = {
      findImplementors: async () => null,
    };
    const result = await handleFindImplementors(notFoundDeps, {
      scip_symbol: mockResult.scip_symbol,
    });
    expect(result.content[0]!.text).toContain("No implementors found");
    expect(result.content[0]!.text).toContain("IOrderService");
  });

  it("passes scip_symbol, repo, limit to client", async () => {
    let capturedSymbol = "";
    let capturedParams: Record<string, unknown> = {};
    const captureDeps: FindImplementorsDeps = {
      findImplementors: async (sym, params) => {
        capturedSymbol = sym;
        capturedParams = params ?? {};
        return null;
      },
    };
    await handleFindImplementors(captureDeps, {
      scip_symbol: "test#.",
      repo: "org/repo",
      limit: 50,
    });
    expect(capturedSymbol).toBe("test#.");
    expect(capturedParams["repo"]).toBe("org/repo");
    expect(capturedParams["limit"]).toBe(50);
  });
});
