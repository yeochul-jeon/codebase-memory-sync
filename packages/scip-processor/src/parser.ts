/**
 * Parses a SCIP binary (protobuf) buffer into an intermediate flat structure
 * ready for Postgres bulk-insert.
 *
 * Uses protobufjs to decode against the bundled scip.proto definition.
 *
 * SCIP range encoding:
 *   4 ints → [startLine, startChar, endLine, endChar]
 *   3 ints → [startLine, startChar, endChar]  (single-line, endLine = startLine)
 *
 * SymbolRole bitmask: Definition=1, Import=2, WriteAccess=4, ReadAccess=8
 */

import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ParsedSymbol {
  scip_symbol: string;
  display_name: string | null;
  kind: string | null;
  language: string;
  file_path: string;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  signature: string | null;
  doc: string | null;
}

export interface ParsedOccurrence {
  scip_symbol: string;
  file_path: string;
  start_line: number;
  start_col: number;
  end_line: number;
  end_col: number;
  role: number;
}

export interface ParsedIndex {
  symbols: ParsedSymbol[];
  occurrences: ParsedOccurrence[];
}

function decodeRange(range: number[]): [number, number, number, number] {
  if (range.length === 4) {
    return [range[0]!, range[1]!, range[2]!, range[3]!];
  }
  if (range.length === 3) {
    return [range[0]!, range[1]!, range[0]!, range[2]!];
  }
  return [0, 0, 0, 0];
}

// SymbolInformation.Kind enum (matches scip.proto)
const KIND_NAMES: Record<number, string> = {
  1: "abstract_method", 2: "accessor", 3: "array", 4: "assertion",
  5: "association", 6: "attribute", 7: "axiom", 8: "boolean",
  9: "class", 10: "constant", 11: "constructor", 12: "data_family",
  13: "delegate", 14: "enum", 15: "enum_member", 16: "error_code",
  17: "event", 18: "extension_method", 19: "fact", 20: "field",
  21: "file", 22: "function", 23: "getter", 24: "grammar",
  25: "instance", 26: "interface", 27: "key", 28: "lang",
  29: "lemma", 30: "local", 31: "macro", 32: "method",
  33: "message_type", 34: "modifier", 35: "module", 36: "namespace",
  37: "null", 38: "number", 39: "object", 40: "operator",
  41: "package", 42: "package_object", 43: "parameter", 44: "parameter_label",
  45: "pattern", 46: "predicate", 47: "property", 48: "protocol",
  49: "pure_virtual_method", 50: "quasi_quoter", 51: "setter", 52: "signature",
  53: "single_type_parameter", 54: "static_data_member", 55: "static_event", 56: "static_field",
  57: "static_method", 58: "static_property", 59: "static_variable", 60: "string",
  61: "struct", 62: "subscript", 63: "tactic", 64: "theorem",
  65: "trait", 66: "type", 67: "type_alias", 68: "type_class",
  69: "type_class_method", 70: "union", 71: "value", 72: "variable",
};

let protoRoot: protobuf.Root | null = null;

async function getProtoRoot(): Promise<protobuf.Root> {
  if (!protoRoot) {
    protoRoot = await protobuf.load(join(__dirname, "scip.proto"));
  }
  return protoRoot;
}

// protobufjs always uses camelCase field names in toObject(), regardless of keepCase option
interface RawOccurrence {
  range?: number[];
  symbol?: string;
  symbolRoles?: number;
}

interface RawSymbolInfo {
  symbol?: string;
  displayName?: string;
  kind?: number;
  documentation?: string[];
}

interface RawDocument {
  language?: string;
  relativePath?: string;
  occurrences?: RawOccurrence[];
  symbols?: RawSymbolInfo[];
}

interface RawIndex {
  documents?: RawDocument[];
}

export async function parseScip(buffer: Buffer): Promise<ParsedIndex> {
  const root = await getProtoRoot();
  const IndexType = root.lookupType("scip.Index");

  const decoded = IndexType.decode(new Uint8Array(buffer));
  // protobufjs always uses camelCase in toObject() output
  const rawIndex = IndexType.toObject(decoded, {
    longs: Number,
    enums: Number,
    defaults: false,
  }) as unknown as RawIndex;

  const symbols: ParsedSymbol[] = [];
  const occurrences: ParsedOccurrence[] = [];

  for (const doc of rawIndex.documents ?? []) {
    const language = doc.language ?? "";
    const filePath = doc.relativePath ?? "";

    // Build lookup: symbol string → SymbolInformation
    const symInfoMap = new Map<string, { displayName: string; kind: number; docs: string[] }>();
    for (const si of doc.symbols ?? []) {
      const sym = si.symbol ?? "";
      symInfoMap.set(sym, {
        displayName: si.displayName ?? sym,
        kind: si.kind ?? 0,
        docs: si.documentation ?? [],
      });
    }

    // Process occurrences
    for (const occ of doc.occurrences ?? []) {
      const sym = occ.symbol ?? "";
      if (!sym || sym.startsWith("local ")) continue;

      const rawRange = occ.range ?? [];
      const [sl, sc, el, ec] = decodeRange(rawRange);
      const role = occ.symbolRoles ?? 0;

      occurrences.push({
        scip_symbol: sym,
        file_path: filePath,
        start_line: sl,
        start_col: sc,
        end_line: el,
        end_col: ec,
        role,
      });

      // Definition (role & 1) → emit a symbol row
      if (role & 1) {
        const info = symInfoMap.get(sym);
        symbols.push({
          scip_symbol: sym,
          display_name: info?.displayName ?? null,
          kind: info ? (KIND_NAMES[info.kind] ?? null) : null,
          language,
          file_path: filePath,
          start_line: sl,
          start_col: sc,
          end_line: el,
          end_col: ec,
          signature: null,
          doc: info?.docs.join("\n") ?? null,
        });
      }
    }
  }

  return { symbols, occurrences };
}
