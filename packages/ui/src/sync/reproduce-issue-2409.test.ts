/**
 * Reproduction test for issue #2409 — xlsx upload not working.
 *
 * Tests that xlsx files are properly converted from their native MIME type
 * (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet)
 * to text/plain before being attached and sent to OpenCode.
 *
 * The error reported by the user is:
 *   Opencode failed to send message with error: 'file part media type
 *   application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
 *   functionality not supported.
 *
 * This error originates from the OpenCode server (litellm provider), indicating
 * that the file was NOT being converted to text/plain before being sent.
 */

import { describe, expect, test } from "bun:test"
import { strToU8, zipSync } from "fflate"
import { prepareAttachmentFiles, prepareAttachmentFile } from "./attachment-files"

const zippedFile = (name: string, entries: Record<string, string | Uint8Array>) => new File([
  zipSync(Object.fromEntries(Object.entries(entries).map(([path, value]) => [
    path,
    typeof value === "string" ? strToU8(value) : value,
  ]))),
], name)

const relationships = (items: Array<{ id: string; target: string; type?: string }>) => `
  <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    ${items.map((item) => `<Relationship Id="${item.id}" Target="${item.target}" Type="${item.type ?? "image"}"/>`).join("")}
  </Relationships>
`

const minimalXlsx = (name = "budget.xlsx"): File => zippedFile(name, {
  "xl/workbook.xml": `
    <workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="Sheet1" r:id="rId1"/></sheets>
    </workbook>`,
  "xl/_rels/workbook.xml.rels": relationships([{ id: "rId1", target: "worksheets/sheet1.xml" }]),
  "xl/sharedStrings.xml": `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Hello</t></si></sst>`,
  "xl/worksheets/sheet1.xml": `
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData>
    </worksheet>`,
  "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
    </Types>`,
})

describe("Issue #2409 — xlsx attachment pipeline", () => {
  test("prepareAttachmentFiles converts xlsx to text/plain", async () => {
    const file = minimalXlsx("budget.xlsx")

    const preparedOrPending = prepareAttachmentFiles(file)
    expect(preparedOrPending).toBeInstanceOf(Promise)

    const preparedFiles = await preparedOrPending
    expect(preparedFiles).toBeDefined()
    expect(preparedFiles!.length).toBeGreaterThanOrEqual(1)

    // The first file must be text/plain — the MIME type that matters for
    // the OpenCode SDK and AI provider. Any other MIME gets rejected.
    expect(preparedFiles![0].mimeType).toBe("text/plain")

    // Content is extracted text, not raw xlsx bytes
    const text = await preparedFiles![0].file.text()
    expect(text).toContain("## Sheet: Sheet1")
    expect(text).toContain("Hello")
  })

  test("without document path (prepareAttachmentFile), xlsx is unprocessable", async () => {
    // If a bug prevents the document path from being taken, the non-document
    // path (prepareAttachmentFile) cannot handle xlsx files because they have
    // an unsupported binary MIME type. The function returns undefined.
    const file = new File(
      [new Uint8Array([0x50, 0x4B, 0x03, 0x04])],
      "budget.xlsx",
      { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    )

    const result = prepareAttachmentFile(file)
    if (result instanceof Promise) {
      expect(await result).toBeUndefined()
    } else {
      expect(result).toBeUndefined()
    }
  })

  test("xlsx MIME is not in the SDK's normalization list", () => {
    // The SDK-level normalizeFilePart (opencode/client.ts) only converts
    // text/* and a small set of app/* types to text/plain. The Office MIME
    // type is NOT in that list. So if a file reaches the send path with its
    // original MIME, it will NOT be normalized and the server will reject it.
    const officeMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

    // This replicates shouldNormalizeToTextPlain from opencode/client.ts
    const shouldNormalize = (mime: string): boolean => {
      if (!mime) return false
      const lower = mime.toLowerCase()
      if (lower.startsWith("text/") && lower !== "text/plain") return true
      return [
        "application/json", "application/xml", "application/javascript",
        "application/typescript", "application/x-yaml", "application/yaml",
        "application/toml", "application/x-sh", "application/x-shellscript",
        "application/octet-stream", "image/svg+xml",
      ].includes(lower)
    }

    expect(shouldNormalize(officeMime)).toBe(false)
    // text/plain is also not "normalized" (already correct)
    expect(shouldNormalize("text/plain")).toBe(false)
  })
})
