/**
 * Tests parseScip() captures Occurrence.enclosing_range into ParsedSymbol.body_* fields.
 *
 * SCIP proto field numbers used here:
 *   Occurrence: range=1 (packed), symbol=2, symbol_roles=3, enclosing_range=7 (packed)
 *   Document:   relative_path=1, occurrences=2, symbols=3, language=4
 *   Index:      metadata=1, documents=3
 */
import { describe, it, expect } from "vitest";
import { parseScip } from "../src/parser.js";

// ── Minimal protobuf encoding helpers ────────────────────────────────────────

function encodeVarint(n: number): Buffer {
  const bytes: number[] = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}

function encodeField(fieldNumber: number, wireType: number, value: Buffer): Buffer {
  return Buffer.concat([encodeVarint((fieldNumber << 3) | wireType), value]);
}

function encodeLengthDelimited(fieldNumber: number, data: Buffer): Buffer {
  return encodeField(fieldNumber, 2, Buffer.concat([encodeVarint(data.length), data]));
}

function encodeStringField(fieldNumber: number, s: string): Buffer {
  return encodeLengthDelimited(fieldNumber, Buffer.from(s, "utf8"));
}

function encodeVarintField(fieldNumber: number, v: number): Buffer {
  return encodeField(fieldNumber, 0, encodeVarint(v));
}

function encodePackedInt32Field(fieldNumber: number, values: number[]): Buffer {
  const packed = Buffer.concat(values.map(encodeVarint));
  return encodeLengthDelimited(fieldNumber, packed);
}

const SYMBOL = "scip-java maven com.example:app 1.0 com/example/OrderService#placeOrder().";

/**
 * Builds a SCIP buffer where the Definition occurrence has:
 *   range           = [10, 2, 10, 22]   (identifier span)
 *   enclosing_range = [8, 0, 20, 1]     (full method body span)
 */
function buildScipWithEnclosingRange(): Buffer {
  const symbolInfo = Buffer.concat([
    encodeStringField(1, SYMBOL),
    encodeVarintField(5, 32), // kind = Method
    encodeStringField(6, "placeOrder"),
  ]);

  const occurrence = Buffer.concat([
    encodePackedInt32Field(1, [10, 2, 10, 22]),  // range (identifier)
    encodeStringField(2, SYMBOL),
    encodeVarintField(3, 1),                      // Definition role
    encodePackedInt32Field(7, [8, 0, 20, 1]),     // enclosing_range (full body)
  ]);

  const document = Buffer.concat([
    encodeStringField(1, "src/OrderService.java"),
    encodeLengthDelimited(2, occurrence),
    encodeLengthDelimited(3, symbolInfo),
    encodeStringField(4, "java"),
  ]);

  const metadata = Buffer.concat([
    encodeVarintField(1, 0),
    encodeStringField(3, "file:///project"),
  ]);

  return Buffer.concat([
    encodeLengthDelimited(1, metadata),
    encodeLengthDelimited(3, document),
  ]);
}

/**
 * Builds a SCIP buffer where the Definition occurrence has NO enclosing_range.
 * body_* should fall back to identifier range.
 */
function buildScipWithoutEnclosingRange(): Buffer {
  const symbolInfo = Buffer.concat([
    encodeStringField(1, SYMBOL),
    encodeVarintField(5, 32),
    encodeStringField(6, "placeOrder"),
  ]);

  const occurrence = Buffer.concat([
    encodePackedInt32Field(1, [10, 2, 10, 22]), // range only, no enclosing_range
    encodeStringField(2, SYMBOL),
    encodeVarintField(3, 1), // Definition
  ]);

  const document = Buffer.concat([
    encodeStringField(1, "src/OrderService.java"),
    encodeLengthDelimited(2, occurrence),
    encodeLengthDelimited(3, symbolInfo),
    encodeStringField(4, "java"),
  ]);

  const metadata = Buffer.concat([
    encodeVarintField(1, 0),
    encodeStringField(3, "file:///project"),
  ]);

  return Buffer.concat([
    encodeLengthDelimited(1, metadata),
    encodeLengthDelimited(3, document),
  ]);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("parseScip — enclosing_range → body_* fields", () => {
  it("ParsedSymbol has body_start_line, body_start_col, body_end_line, body_end_col fields", async () => {
    const buf = buildScipWithEnclosingRange();
    const result = await parseScip(buf);
    const sym = result.symbols[0]!;
    expect(sym).toHaveProperty("body_start_line");
    expect(sym).toHaveProperty("body_start_col");
    expect(sym).toHaveProperty("body_end_line");
    expect(sym).toHaveProperty("body_end_col");
  });

  it("uses enclosing_range for body_* when present", async () => {
    const buf = buildScipWithEnclosingRange();
    const result = await parseScip(buf);
    const sym = result.symbols[0]!;
    // enclosing_range = [8, 0, 20, 1]
    expect(sym.body_start_line).toBe(8);
    expect(sym.body_start_col).toBe(0);
    expect(sym.body_end_line).toBe(20);
    expect(sym.body_end_col).toBe(1);
  });

  it("body_* differs from identifier range when enclosing_range is present", async () => {
    const buf = buildScipWithEnclosingRange();
    const result = await parseScip(buf);
    const sym = result.symbols[0]!;
    // identifier range [10, 2, 10, 22] ≠ body [8, 0, 20, 1]
    expect(sym.body_start_line).not.toBe(sym.start_line);
  });

  it("falls back to identifier range for body_* when enclosing_range absent", async () => {
    const buf = buildScipWithoutEnclosingRange();
    const result = await parseScip(buf);
    const sym = result.symbols[0]!;
    // identifier range = [10, 2, 10, 22]
    expect(sym.body_start_line).toBe(10);
    expect(sym.body_start_col).toBe(2);
    expect(sym.body_end_line).toBe(10);
    expect(sym.body_end_col).toBe(22);
  });

  it("identifier range (start_line/col) is unchanged regardless of enclosing_range", async () => {
    const buf = buildScipWithEnclosingRange();
    const result = await parseScip(buf);
    const sym = result.symbols[0]!;
    expect(sym.start_line).toBe(10);
    expect(sym.start_col).toBe(2);
    expect(sym.end_line).toBe(10);
    expect(sym.end_col).toBe(22);
  });
});
