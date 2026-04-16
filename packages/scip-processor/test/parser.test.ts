import { describe, it, expect } from "vitest";
import { buildHelloScip } from "./fixtures/build-hello-scip.js";
import { parseScip } from "../src/parser.js";

describe("parseScip", () => {
  it("parses a minimal SCIP binary and returns at least 1 symbol and 1 occurrence", async () => {
    const buf = buildHelloScip();
    const result = await parseScip(buf);

    expect(result.symbols.length).toBeGreaterThanOrEqual(1);
    expect(result.occurrences.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts correct symbol properties", async () => {
    const buf = buildHelloScip();
    const result = await parseScip(buf);

    const sym = result.symbols[0];
    expect(sym).toBeDefined();
    expect(sym!.scip_symbol).toContain("OrderService");
    expect(sym!.display_name).toBe("placeOrder");
    expect(sym!.kind).toBe("method");
    expect(sym!.language).toBe("java");
    expect(sym!.file_path).toContain("OrderService.java");
    expect(sym!.start_line).toBe(10);
    expect(sym!.end_line).toBe(10);
  });

  it("extracts correct occurrence properties", async () => {
    const buf = buildHelloScip();
    const result = await parseScip(buf);

    const occ = result.occurrences[0];
    expect(occ).toBeDefined();
    expect(occ!.scip_symbol).toContain("OrderService");
    expect(occ!.file_path).toContain("OrderService.java");
    expect(occ!.role).toBe(1); // Definition
    expect(occ!.start_line).toBe(10);
    expect(occ!.end_col).toBe(22);
  });

  it("filters out local symbols", async () => {
    const buf = buildHelloScip();
    const result = await parseScip(buf);
    const locals = result.symbols.filter((s) => s.scip_symbol.startsWith("local "));
    expect(locals).toHaveLength(0);
  });
});
