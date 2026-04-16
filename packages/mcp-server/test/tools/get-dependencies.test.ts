import { describe, it, expect } from "vitest";
import {
  handleGetDependencies,
  type GetDependenciesDeps,
} from "../../src/tools/get-dependencies.js";

const mockResult = {
  scip_symbol:
    "scip-java maven com.example:app 1.0 com/example/OrderService#.",
  total: 2,
  truncated: false,
  dependencies: [
    {
      to_symbol:
        "scip-java maven com.example:app 1.0 com/example/IPayment#.",
      display_name: "IPayment",
      kind: "interface",
      file_path: "src/IPayment.java",
      start_line: 1,
      is_reference: false,
      is_implementation: false,
      is_type_definition: true,
      is_definition: false,
      repo: "acme/backend",
      commit_sha: "abc1234567890",
    },
    {
      to_symbol:
        "scip-java maven com.example:app 1.0 com/example/Inventory#.",
      display_name: "Inventory",
      kind: "class",
      file_path: "src/Inventory.java",
      start_line: 3,
      is_reference: true,
      is_implementation: false,
      is_type_definition: false,
      is_definition: false,
      repo: "acme/backend",
      commit_sha: "abc1234567890",
    },
  ],
};

const mockDeps: GetDependenciesDeps = {
  getDependencies: async () => mockResult,
};

describe("handleGetDependencies", () => {
  it("returns a single text content block", async () => {
    const result = await handleGetDependencies(mockDeps, {
      scip_symbol: mockResult.scip_symbol,
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
  });

  it("includes source symbol and total in output", async () => {
    const result = await handleGetDependencies(mockDeps, {
      scip_symbol: mockResult.scip_symbol,
    });
    const text = result.content[0]!.text;
    expect(text).toContain("OrderService");
    expect(text).toContain("2");
  });

  it("lists each dependency with display name, kind, and relationship type", async () => {
    const result = await handleGetDependencies(mockDeps, {
      scip_symbol: mockResult.scip_symbol,
    });
    const text = result.content[0]!.text;
    expect(text).toContain("IPayment");
    expect(text).toContain("interface");
    expect(text).toContain("type_definition");
    expect(text).toContain("Inventory");
    expect(text).toContain("reference");
  });

  it("returns not-found message when result is null", async () => {
    const notFoundDeps: GetDependenciesDeps = {
      getDependencies: async () => null,
    };
    const result = await handleGetDependencies(notFoundDeps, {
      scip_symbol: mockResult.scip_symbol,
    });
    expect(result.content[0]!.text).toContain("No dependencies found");
    expect(result.content[0]!.text).toContain("OrderService");
  });

  it("passes scip_symbol, repo, limit to client", async () => {
    let capturedSymbol = "";
    let capturedParams: Record<string, unknown> = {};
    const captureDeps: GetDependenciesDeps = {
      getDependencies: async (sym, params) => {
        capturedSymbol = sym;
        capturedParams = params ?? {};
        return null;
      },
    };
    await handleGetDependencies(captureDeps, {
      scip_symbol: "test#.",
      repo: "org/repo",
      limit: 25,
    });
    expect(capturedSymbol).toBe("test#.");
    expect(capturedParams["repo"]).toBe("org/repo");
    expect(capturedParams["limit"]).toBe(25);
  });
});
