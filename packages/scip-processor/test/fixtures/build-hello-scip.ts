/**
 * Generates a minimal SCIP protobuf binary for use in tests.
 *
 * Uses raw protobuf wire encoding (no external library dependency at build time).
 *
 * Wire types: 0=varint, 2=length-delimited
 * Field encoding: (field_number << 3) | wire_type
 *
 * SCIP proto field numbers (from scip.proto):
 *   Index:             metadata=1, documents=3
 *   Metadata:          version=1, project_root=3
 *   Document:          relative_path=1, occurrences=2, symbols=3, language=4
 *   Occurrence:        range=1 (packed), symbol=2, symbol_roles=3
 *   SymbolInformation: symbol=1, kind=5 (enum varint), display_name=6
 */

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

/** Encode field as length-delimited (wire type 2): tag + length_varint + data */
function encodeLengthDelimited(fieldNumber: number, data: Buffer): Buffer {
  return encodeField(fieldNumber, 2, Buffer.concat([encodeVarint(data.length), data]));
}

/** Encode a string field: tag + string_length_varint + utf8_bytes */
function encodeStringField(fieldNumber: number, s: string): Buffer {
  return encodeLengthDelimited(fieldNumber, Buffer.from(s, "utf8"));
}

/** Encode a varint field (wire type 0): tag + varint */
function encodeVarintField(fieldNumber: number, v: number): Buffer {
  return encodeField(fieldNumber, 0, encodeVarint(v));
}

/** Encode a packed int32 array field (wire type 2): tag + packed_varint_bytes */
function encodePackedInt32Field(fieldNumber: number, values: number[]): Buffer {
  const packed = Buffer.concat(values.map(encodeVarint));
  return encodeLengthDelimited(fieldNumber, packed);
}

/**
 * Returns a Buffer containing a minimal valid SCIP Index:
 *   - 1 document: OrderService.java
 *     - 1 SymbolInformation: placeOrder (kind=Method=32)
 *     - 1 Occurrence: Definition role=1, range=[10,2,10,22]
 */
export function buildHelloScip(): Buffer {
  const SYMBOL = "scip-java maven com.example:app 1.0 com/example/OrderService#placeOrder().";

  // ── SymbolInformation ─────────────────────────────────────────────────────
  // symbol=1 (string), kind=5 (enum varint: Method=32), display_name=6 (string)
  const symbolInfo = Buffer.concat([
    encodeStringField(1, SYMBOL),
    encodeVarintField(5, 32),       // kind = Method (32 in SymbolInformation.Kind)
    encodeStringField(6, "placeOrder"), // display_name
  ]);

  // ── Occurrence ────────────────────────────────────────────────────────────
  // range=1 (packed int32: [startLine, startChar, endLine, endChar])
  // symbol=2 (string), symbol_roles=3 (varint: Definition=1)
  const occurrence = Buffer.concat([
    encodePackedInt32Field(1, [10, 2, 10, 22]),
    encodeStringField(2, SYMBOL),
    encodeVarintField(3, 1), // Definition
  ]);

  // ── Document ─────────────────────────────────────────────────────────────
  // relative_path=1, occurrences=2 (repeated message), symbols=3 (repeated message), language=4
  const document = Buffer.concat([
    encodeStringField(1, "src/main/java/com/example/OrderService.java"), // relative_path
    encodeLengthDelimited(2, occurrence),  // occurrences (repeated → one entry)
    encodeLengthDelimited(3, symbolInfo),  // symbols (repeated → one entry)
    encodeStringField(4, "java"),          // language
  ]);

  // ── Metadata ─────────────────────────────────────────────────────────────
  // version=1 (varint: 0=Unspecified), project_root=3 (string)
  const metadata = Buffer.concat([
    encodeVarintField(1, 0),
    encodeStringField(3, "file:///project"),
  ]);

  // ── Index ─────────────────────────────────────────────────────────────────
  // metadata=1 (message), documents=3 (repeated message)
  return Buffer.concat([
    encodeLengthDelimited(1, metadata),
    encodeLengthDelimited(3, document),
  ]);
}
