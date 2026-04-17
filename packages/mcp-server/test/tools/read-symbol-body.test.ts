import { describe, it, expect, vi } from "vitest";
import { handleReadSymbolBody } from "../../src/tools/read-symbol-body.js";
import type { ReadSymbolBodyDeps } from "../../src/tools/read-symbol-body.js";

const SYMBOL = "scip-java maven com.example:app 1.0 com/example/Foo#bar().";

const MOCK_RESULT = {
  repo: "myorg/myapp",
  commit_sha: "abc123def456",
  scip_symbol: SYMBOL,
  file_path: "src/Foo.java",
  start_line: 8,
  end_line: 20,
  content: "    public void bar() {\n        System.out.println(42);\n    }",
  body_source: "enclosing_range" as const,
};

describe("handleReadSymbolBody", () => {
  it("returns formatted source body for a known symbol", async () => {
    const deps: ReadSymbolBodyDeps = {
      readSymbolBody: vi.fn().mockResolvedValue(MOCK_RESULT),
    };
    const result = await handleReadSymbolBody(deps, { scip_symbol: SYMBOL, repo: "myorg/myapp" });
    expect(result.content[0]?.text).toContain("src/Foo.java");
    expect(result.content[0]?.text).toContain("public void bar()");
  });

  it("includes file:line range in output", async () => {
    const deps: ReadSymbolBodyDeps = {
      readSymbolBody: vi.fn().mockResolvedValue(MOCK_RESULT),
    };
    const result = await handleReadSymbolBody(deps, { scip_symbol: SYMBOL });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("8");
    expect(text).toContain("20");
  });

  it("indicates identifier_fallback when body_source is identifier_fallback", async () => {
    const deps: ReadSymbolBodyDeps = {
      readSymbolBody: vi.fn().mockResolvedValue({
        ...MOCK_RESULT,
        body_source: "identifier_fallback" as const,
      }),
    };
    const result = await handleReadSymbolBody(deps, { scip_symbol: SYMBOL });
    expect(result.content[0]?.text).toContain("identifier_fallback");
  });

  it("returns not-found message when symbol is unknown (null from client)", async () => {
    const deps: ReadSymbolBodyDeps = {
      readSymbolBody: vi.fn().mockResolvedValue(null),
    };
    const result = await handleReadSymbolBody(deps, { scip_symbol: SYMBOL });
    expect(result.content[0]?.text).toContain("not found");
  });

  it("passes branch param to readSymbolBody", async () => {
    const readSymbolBody = vi.fn().mockResolvedValue(null);
    await handleReadSymbolBody({ readSymbolBody }, {
      scip_symbol: SYMBOL,
      repo: "myorg/myapp",
      branch: "feature",
    });
    expect(readSymbolBody).toHaveBeenCalledWith(
      SYMBOL,
      expect.objectContaining({ branch: "feature" })
    );
  });

  it("returns not-available message when source is not available (404-style null with hint)", async () => {
    const deps: ReadSymbolBodyDeps = {
      readSymbolBody: vi.fn().mockResolvedValue(null),
    };
    const result = await handleReadSymbolBody(deps, { scip_symbol: SYMBOL, repo: "myorg/myapp" });
    expect(result.content[0]?.text).toContain("not found");
    expect(result.content[0]?.type).toBe("text");
  });
});
