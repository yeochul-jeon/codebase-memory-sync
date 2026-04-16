import { describe, it, expect } from "vitest";
import { handleSearchSymbols } from "../../src/tools/search-symbols.js";
import type { SearchSymbolsDeps } from "../../src/tools/search-symbols.js";

const mockResults = [
  {
    scip_symbol: "scip-java maven com.example:app 1.0 com/example/OrderService#placeOrder().",
    display_name: "placeOrder",
    kind: "method",
    language: "java",
    file_path: "src/main/java/com/example/OrderService.java",
    start_line: 10,
    end_line: 11,
    repo: "acme/backend",
    commit_sha: "abc1234567890",
  },
];

const mockDeps: SearchSymbolsDeps = {
  searchSymbols: async () => ({ results: mockResults, total: 1 }),
};

describe("handleSearchSymbols", () => {
  it("returns text content block", async () => {
    const result = await handleSearchSymbols(mockDeps, { query: "placeOrder" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
  });

  it("shows symbol name and kind in output", async () => {
    const result = await handleSearchSymbols(mockDeps, { query: "placeOrder" });
    const text = result.content[0]!.text;
    expect(text).toContain("placeOrder");
    expect(text).toContain("[method]");
  });

  it("includes repo and file info", async () => {
    const result = await handleSearchSymbols(mockDeps, { query: "placeOrder" });
    const text = result.content[0]!.text;
    expect(text).toContain("acme/backend");
    expect(text).toContain("OrderService.java");
    expect(text).toContain(":10");
  });

  it("returns 'No symbols found.' when results are empty", async () => {
    const emptyDeps: SearchSymbolsDeps = {
      searchSymbols: async () => ({ results: [], total: 0 }),
    };
    const result = await handleSearchSymbols(emptyDeps, { query: "nonexistent" });
    expect(result.content[0]!.text).toBe("No symbols found.");
  });

  it("passes filter params to client", async () => {
    let capturedParams: Record<string, unknown> = {};
    const captureDeps: SearchSymbolsDeps = {
      searchSymbols: async (params) => {
        capturedParams = params as Record<string, unknown>;
        return { results: [], total: 0 };
      },
    };
    await handleSearchSymbols(captureDeps, {
      query: "Foo",
      repo: "acme/app",
      language: "java",
      kind: "class",
      limit: 10,
    });
    expect(capturedParams["q"]).toBe("Foo");
    expect(capturedParams["repo"]).toBe("acme/app");
    expect(capturedParams["lang"]).toBe("java");
    expect(capturedParams["kind"]).toBe("class");
    expect(capturedParams["limit"]).toBe(10);
  });
});
