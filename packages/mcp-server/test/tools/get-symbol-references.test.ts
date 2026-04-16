import { describe, it, expect } from "vitest";
import {
  handleGetSymbolReferences,
  type GetSymbolReferencesDeps,
} from "../../src/tools/get-symbol-references.js";

const SCIP_SYMBOL =
  "scip-java maven com.example:app 1.0 com/example/OrderService#placeOrder().";

const mockReferences = {
  scip_symbol: SCIP_SYMBOL,
  repo: "acme/backend",
  commit_sha: "abc1234567890",
  total: 3,
  truncated: false,
  occurrences: [
    { file_path: "src/Controller.java", start_line: 24, start_col: 8, end_line: 24, end_col: 20, role: 8 },
    { file_path: "src/Service.java",    start_line: 10, start_col: 2, end_line: 10, end_col: 14, role: 4 },
    { file_path: "src/Test.java",       start_line: 5,  start_col: 0, end_line: 5,  end_col: 12, role: 8 },
  ],
};

const mockDeps: GetSymbolReferencesDeps = {
  getSymbolReferences: async () => mockReferences,
};

describe("handleGetSymbolReferences", () => {
  it("returns a single text content block", async () => {
    const result = await handleGetSymbolReferences(mockDeps, {
      scip_symbol: SCIP_SYMBOL,
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
  });

  it("includes symbol, repo, and total in output", async () => {
    const result = await handleGetSymbolReferences(mockDeps, {
      scip_symbol: SCIP_SYMBOL,
    });
    const text = result.content[0]!.text;
    expect(text).toContain("placeOrder");
    expect(text).toContain("acme/backend");
    expect(text).toContain("3");
  });

  it("lists each occurrence with file and role label", async () => {
    const result = await handleGetSymbolReferences(mockDeps, {
      scip_symbol: SCIP_SYMBOL,
    });
    const text = result.content[0]!.text;
    expect(text).toContain("Controller.java:24");
    expect(text).toContain("READ");
    expect(text).toContain("Service.java:10");
    expect(text).toContain("WRITE");
  });

  it("returns not-found message when result is null", async () => {
    const notFoundDeps: GetSymbolReferencesDeps = {
      getSymbolReferences: async () => null,
    };
    const result = await handleGetSymbolReferences(notFoundDeps, {
      scip_symbol: SCIP_SYMBOL,
    });
    expect(result.content[0]!.text).toContain("No references found");
    expect(result.content[0]!.text).toContain("placeOrder");
  });

  it("appends truncation notice when truncated=true", async () => {
    const truncatedDeps: GetSymbolReferencesDeps = {
      getSymbolReferences: async () => ({
        ...mockReferences,
        total: 200,
        truncated: true,
        occurrences: mockReferences.occurrences.slice(0, 1),
      }),
    };
    const result = await handleGetSymbolReferences(truncatedDeps, {
      scip_symbol: SCIP_SYMBOL,
    });
    const text = result.content[0]!.text;
    expect(text).toContain("200");
    expect(text).toMatch(/truncated|showing/i);
  });

  it("passes args to the client correctly", async () => {
    let capturedSym = "";
    let capturedRepo: string | undefined;
    const captureDeps: GetSymbolReferencesDeps = {
      getSymbolReferences: async (sym, opts) => {
        capturedSym = sym;
        capturedRepo = opts?.repo;
        return null;
      },
    };
    await handleGetSymbolReferences(captureDeps, {
      scip_symbol: SCIP_SYMBOL,
      repo: "acme/backend",
    });
    expect(capturedSym).toBe(SCIP_SYMBOL);
    expect(capturedRepo).toBe("acme/backend");
  });
});
