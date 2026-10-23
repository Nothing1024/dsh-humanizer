/**
 * .docx → plain text / light Markdown for the UI's import button. A .docx is a zip; only
 * `word/document.xml` is read (central directory + raw deflate from node:zlib, no dependency).
 * Paragraphs become lines separated by a blank line, Heading 1–6 styles become `#` headings, list
 * paragraphs become `- ` items, tabs and line breaks are kept. Tables become one line per row
 * with cells joined by " | ". Formatting, images and footnotes are dropped.
 * @module dsh-tool-humanize/docx
 */
import { inflateRawSync } from 'node:zlib'

export class DocxError extends Error {}

function findEntry(buf: Buffer, name: string): Buffer {
  // End of central directory: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new DocxError('不是有效的 .docx（zip 结构损坏）')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new DocxError('不是有效的 .docx（目录损坏）')
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const local = buf.readUInt32LE(off + 42)
    const entry = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    if (entry === name) {
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new DocxError('不是有效的 .docx（文件头损坏）')
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
      const data = buf.subarray(start, start + csize)
      if (method === 0) return Buffer.from(data)
      if (method === 8) return inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 })
      throw new DocxError(`不支持的压缩方式 ${method}`)
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  throw new DocxError('文件里没有 word/document.xml，可能不是 Word 文档')
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e] ?? m
  })
}

function runText(xml: string): string {
  let out = ''
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>|<w:noBreakHyphen\/>/g
  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) out += decode(m[1])
    else if (m[0].startsWith('<w:tab')) out += '\t'
    else if (m[0].startsWith('<w:noBreakHyphen')) out += '-'
    else out += '\n'
  }
  return out
}

function paragraph(xml: string): string {
  const text = runText(xml).replace(/[ \t]+$/g, '')
  if (!text.trim()) return ''
  const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(xml)?.[1] ?? ''
  const h = /^(?:Heading|heading|标题)\s*([1-6])$/.exec(style)
  if (h) return `${'#'.repeat(Number(h[1]))} ${text.trim()}`
  if (style === 'Title') return `# ${text.trim()}`
  if (/<w:numPr>/.test(xml) || /^List/.test(style)) return `- ${text.trim()}`
  return text
}

/** Extract the document text (see module doc). */
export function docxToText(buf: Buffer): string {
  const xml = findEntry(buf, 'word/document.xml').toString('utf8')
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml
  const blocks: string[] = []
  const re = /<w:tbl>([\s\S]*?)<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g
  for (const m of body.matchAll(re)) {
    if (m[1] !== undefined) {
      const rows = [...m[1].matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((r) =>
        [...r[0].matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)].map((c) => runText(c[0]).replace(/\s+/g, ' ').trim()).join(' | '))
      if (rows.length) blocks.push(rows.join('\n'))
    } else {
      const p = paragraph(m[0])
      if (p) blocks.push(p)
    }
  }
  // Consecutive list items stay together; other blocks are separated by a blank line.
  let out = ''
  blocks.forEach((b, i) => {
    if (i > 0) out += b.startsWith('- ') && blocks[i - 1]!.startsWith('- ') ? '\n' : '\n\n'
    out += b
  })
  return out
}
