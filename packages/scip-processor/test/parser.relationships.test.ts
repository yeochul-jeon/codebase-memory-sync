/**
 * Tests parseScip() relationship extraction.
 *
 * SCIP proto field numbers used here:
 *   SymbolInformation: symbol=1, relationships=4, kind=5, display_name=6
 *   Relationship:      symbol=1, is_reference=2, is_implementation=3,
 *                      is_type_definition=4, is_definition=5
 *   Document:          relative_path=1, occurrences=2, symbols=3, language=4
 *   Occurrence:        range=1 (packed), symbol=2, symbol_roles=3
 *   Index:             metadata=1, documents=3
 */
import { describe, it, expect } from "vitest";
import { parseScip } from "../src/parser.js";

// ── Minimal protobuf encoding helpers (duplicated from build-hello-scip.ts) ──

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

// ── Fixture: SCIP index with a Relationship ──────────────────────────────────

const FROM_SYMBOL = "scip-java maven com.example:app 1.0 com/example/FooImpl#.";
const TO_SYMBOL = "scip-java maven com.example:app 1.0 com/example/IFoo#.";

/**
 * Builds a SCIP buffer where FooImpl has a `relationships` entry
 * pointing to IFoo with is_implementation=true.
 */
function buildScipWithRelationship(): Buffer {
  // Relationship message: symbol=1 (IFoo), is_implementation=3 (bool=true)
  const relationship = Buffer.concat([
    encodeStringField(1, TO_SYMBOL),
    encodeVarintField(3, 1), // is_implementation = true
  ]);

  // SymbolInformation for FooImpl with the relationship
  const symbolInfoFooImpl = Buffer.concat([
    encodeStringField(1, FROM_SYMBOL),
    encodeLengthDelimited(4, relationship), // relationships field = 4
    encodeVarintField(5, 9),               // kind = class (9)
    encodeStringField(6, "FooImpl"),        // display_name
  ]);

  // Occurrence for FooImpl (definition role=1)
  const occurrence = Buffer.concat([
    encodePackedInt32Field(1, [5, 0, 5, 7]),
    encodeStringField(2, FROM_SYMBOL),
    encodeVarintField(3, 1), // Definition role
  ]);

  // Document
  const document = Buffer.concat([
    encodeStringField(1, "src/FooImpl.java"),
    encodeLengthDelimited(2, occurrence),
    encodeLengthDelimited(3, symbolInfoFooImpl),
    encodeStringField(4, "java"),
  ]);

  // Metadata
  const metadata = Buffer.concat([
    encodeVarintField(1, 0),
    encodeStringField(3, "file:///project"),
  ]);

  // Index
  return Buffer.concat([
    encodeLengthDelimited(1, metadata),
    encodeLengthDelimited(3, document),
  ]);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("parseScip — relationships", () => {
  it("returns a relationships array on ParsedIndex", async () => {
    const buf = buildScipWithRelationship();
    const result = await parseScip(buf);
    expect(Array.isArray(result.relationships)).toBe(true);
  });

  it("extracts one relationship from the fixture", async () => {
    const buf = buildScipWithRelationship();
    const result = await parseScip(buf);
    expect(result.relationships).toHaveLength(1);
  });

  it("sets from_symbol and to_symbol correctly", async () => {
    const buf = buildScipWithRelationship();
    const result = await parseScip(buf);
    const rel = result.relationships[0]!;
    expect(rel.from_symbol).toBe(FROM_SYMBOL);
    expect(rel.to_symbol).toBe(TO_SYMBOL);
  });

  it("sets is_implementation=true and other flags false", async () => {
    const buf = buildScipWithRelationship();
    const result = await parseScip(buf);
    const rel = result.relationships[0]!;
    expect(rel.is_implementation).toBe(true);
    expect(rel.is_reference).toBe(false);
    expect(rel.is_type_definition).toBe(false);
    expect(rel.is_definition).toBe(false);
  });

  it("returns empty relationships when no relationships are present", async () => {
    // buildHelloScip has no relationships
    const { buildHelloScip } = await import("./fixtures/build-hello-scip.js");
    const buf = buildHelloScip();
    const result = await parseScip(buf);
    expect(result.relationships).toHaveLength(0);
  });
});
