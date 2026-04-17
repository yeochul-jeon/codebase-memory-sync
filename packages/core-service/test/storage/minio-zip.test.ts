/**
 * Unit tests for extractZipEntry() — pure zip extraction helper.
 * No MinIO / S3 required.
 */
import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import { extractZipEntry } from "../../src/storage/minio.js";

function buildZip(entries: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content, "utf8"));
  }
  return zip.toBuffer();
}

describe("extractZipEntry", () => {
  it("returns file content when the path exists in the zip", () => {
    const content = "public class Foo {}";
    const buf = buildZip({ "src/Foo.java": content });
    const result = extractZipEntry(buf, "src/Foo.java");
    expect(result).not.toBeNull();
    expect(result!.toString("utf8")).toBe(content);
  });

  it("returns null when the path does not exist in the zip", () => {
    const buf = buildZip({ "src/Foo.java": "class Foo {}" });
    const result = extractZipEntry(buf, "src/Bar.java");
    expect(result).toBeNull();
  });

  it("handles nested paths correctly", () => {
    const content = "export const x = 1;";
    const buf = buildZip({ "packages/app/src/index.ts": content });
    const result = extractZipEntry(buf, "packages/app/src/index.ts");
    expect(result!.toString("utf8")).toBe(content);
  });

  it("returns correct content when zip has multiple files", () => {
    const buf = buildZip({
      "src/Foo.java": "class Foo {}",
      "src/Bar.java": "class Bar {}",
      "src/Baz.java": "class Baz {}",
    });
    const result = extractZipEntry(buf, "src/Bar.java");
    expect(result!.toString("utf8")).toBe("class Bar {}");
  });

  it("returns a Buffer (not a string or other type)", () => {
    const buf = buildZip({ "src/Foo.java": "class Foo {}" });
    const result = extractZipEntry(buf, "src/Foo.java");
    expect(Buffer.isBuffer(result)).toBe(true);
  });
});
