import { describe, it, expect } from "vitest";
import { handleGetSymbolDetail } from "../../src/tools/get-symbol-detail.js";
import type { GetSymbolDetailDeps } from "../../src/tools/get-symbol-detail.js";

const SCIP_SYMBOL = "scip-java maven com.example:app 1.0 com/example/OrderService#placeOrder().";

const mockDetail = {
  symbol: {
    scip_symbol: SCIP_SYMBOL,
    display_name: "placeOrder",
    kind: "method",
    language: "java",
    file_path: "src/main/java/com/example/OrderService.java",
    start_line: 10,
    start_col: 2,
    end_line: 11,
    end_col: 3,
    signature: null,
    doc: null,
  },
  repo: "acme/backend",
  commit_sha: "abc1234567890",
  occurrences: [
    { file_path: "src/main/java/com/example/OrderService.java", start_line: 10, start_col: 2, end_line: 11, end_col: 3, role: 1 },
    { file_path: "src/main/java/com/example/OrderController.java", start_line: 24, start_col: 8, end_line: 24, end_col: 20, role: 8 },
  ],
};

const mockDeps: GetSymbolDetailDeps = {
  getSymbolDetail: async () => mockDetail,
};

describe("handleGetSymbolDetail", () => {
  it("returns text content block", async () => {
    const result = await handleGetSymbolDetail(mockDeps, { scip_symbol: SCIP_SYMBOL });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
  });

  it("includes symbol name, kind, and file info", async () => {
    const result = await handleGetSymbolDetail(mockDeps, { scip_symbol: SCIP_SYMBOL });
    const text = result.content[0]!.text;
    expect(text).toContain("placeOrder");
    expect(text).toContain("method");
    expect(text).toContain("OrderService.java");
    expect(text).toContain("10");
  });

  it("includes occurrences list", async () => {
    const result = await handleGetSymbolDetail(mockDeps, { scip_symbol: SCIP_SYMBOL });
    const text = result.content[0]!.text;
    expect(text).toContain("References");
    expect(text).toContain("OrderController.java");
  });

  it("returns not-found message when symbol is null", async () => {
    const notFoundDeps: GetSymbolDetailDeps = {
      getSymbolDetail: async () => null,
    };
    const result = await handleGetSymbolDetail(notFoundDeps, { scip_symbol: "scip-unknown ." });
    expect(result.content[0]!.text).toContain("Symbol not found");
  });

  it("passes scip_symbol to client", async () => {
    let captured = "";
    const captureDeps: GetSymbolDetailDeps = {
      getSymbolDetail: async (sym) => { captured = sym; return null; },
    };
    await handleGetSymbolDetail(captureDeps, { scip_symbol: SCIP_SYMBOL });
    expect(captured).toBe(SCIP_SYMBOL);
  });
});
