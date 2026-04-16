#!/usr/bin/env tsx
// Generates a minimal test SCIP fixture binary and writes it to the specified path.
// Usage: tsx scripts/make-fixture.ts [output-path]
import { buildHelloScip } from "../packages/scip-processor/test/fixtures/build-hello-scip.js";
import { writeFileSync } from "node:fs";

const output = process.argv[2] ?? "/tmp/cms-test-fixture.scip";
const buf = buildHelloScip();
writeFileSync(output, buf);
console.log(`Fixture written: ${buf.length} bytes → ${output}`);
