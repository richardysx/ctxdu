#!/usr/bin/env node
/**
 * 生成 README 用的演示 GIF —— 完全离线，零 npm 依赖。
 *
 * 管线：HTML 帧 -> 无头 Chrome 截图 -> 解 PNG -> 中位切分量化 -> LZW 编码 GIF89a
 * 之所以自己写，是因为 vhs/ffmpeg 的 bottle 源在本网络下不可达。
 *
 * 用法: node tools/make-gif.mjs [session] > /dev/null   (产物 demo.gif)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const WORK = join(tmpdir(), 'ctxdu-gif')

// ── 1. 取真实输出 ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const session = argv.find((a) => !a.startsWith('--')) || ''
const ci = argv.indexOf('--cwd')                    // 会话属于哪个项目目录
const cwd = ci >= 0 ? argv[ci + 1] : join(ROOT, '..')
const out = execFileSync('node', [join(ROOT, 'ctxdu.mjs'), ...(session ? [session] : [])],
  { encoding: 'utf8', cwd }).replace(/\n+$/, '')
const lines = out.split('\n')

// ── 2. 造 HTML 帧 ────────────────────────────────────────────────────────────
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function paint(line) {
  const t = esc(line)
  if (/^  ctxdu —/.test(line)) return `<i class=hdr>${t}</i>`
  if (/^  used /.test(line)) return t
    .replace(/^(  )(used)/, '$1<i class=dim>$2</i>')
    .replace(/(\d[\d,]*) \/ (\d[\d,]*)/, '<i class=big>$1</i> <i class=dim>/ $2</i>')
    .replace(/(\d+\.\d%)/, '<i class=warn>$1</i>')
    .replace(/(█+)/, '<i class=warn>$1</i>').replace(/(░+)/, '<i class=track>$1</i>')
  if (/^  (Fixed overhead|Tool results|Findings|MCP)/.test(line)) return `<i class=sect>${t}</i>`
  if (/^    !  /.test(line)) return t.replace(/^(\s*)(!)(\s+)(.*)$/, '$1<i class=warn>$2</i>$3<i class=find>$4</i>')
  if (/[█░]/.test(line)) return t
    .replace(/(█+)/, '<i class=bar>$1</i>').replace(/(░+)/, '<i class=track>$1</i>')
    .replace(/(\d[\d,]{2,})/, '<i class=num>$1</i>')
  if (/&lt;- you control this/.test(t)) return t.replace(/(&lt;- you control this)/, '<i class=ok>$1</i>')
  if (/\(not controllable\)/.test(line)) return t.replace(/(\(not controllable\))/, '<i class=dim>$1</i>')
  return t.replace(/^(\s*)(\d[\d,]*)/, '$1<i class=num>$2</i>')
}

const CSS = `body{margin:0;background:#0d1117}
pre{margin:0;padding:22px;font:13px/1.46 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c9d1d9}
i{font-style:normal}
.p{color:#3fb950}.cmd{color:#e6edf3;font-weight:600}.cur{background:#c9d1d9;color:#0d1117}
.hdr{color:#8b949e}.dim{color:#6e7681}.sect{color:#e6edf3;font-weight:600}
.big{color:#e6edf3;font-weight:600}.num{color:#79c0ff}.bar{color:#58a6ff}
.track{color:#21262d}.warn{color:#d29922}.find{color:#f0883e}.ok{color:#3fb950}`

const CMD = 'ctxdu'
const frames = []
for (let i = 0; i <= CMD.length; i++)
  frames.push({ body: `<i class=p>$</i> <i class=cmd>${CMD.slice(0, i)}</i><i class=cur> </i>`, delay: i === 0 ? 60 : 9 })
frames.push({ body: `<i class=p>$</i> <i class=cmd>${CMD}</i>`, delay: 35 })
frames.push({ body: `<i class=p>$</i> <i class=cmd>${CMD}</i>\n` + lines.map(paint).join('\n'), delay: 600 })

// 测试用：只保留最后一帧（数据量最大，用于验证 LZW 的字典增长/重置路径）
if (argv.includes('--only-last')) { frames.splice(0, frames.length - 1) }

// ── 3. Chrome 截图 ───────────────────────────────────────────────────────────
const COLS = Math.max(...lines.map((l) => [...l].length), 20)
const W = Math.ceil(COLS * 7.83 + 44)
const H = Math.ceil((lines.length + 2) * 19 + 44)

rmSync(WORK, { recursive: true, force: true }); mkdirSync(WORK, { recursive: true })
const shots = frames.map((f, i) => {
  const html = join(WORK, `f${i}.html`), png = join(WORK, `f${i}.png`)
  writeFileSync(html, `<html><head><meta charset=utf-8><style>${CSS}</style></head><body><pre>${f.body}</pre></body></html>`)
  execFileSync(CHROME, ['--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    `--screenshot=${png}`, `--window-size=${W},${H}`, `file://${html}`], { stdio: 'ignore' })
  return png
})

// ── 4. 解 PNG ────────────────────────────────────────────────────────────────
function unfilter(f, line, prev, bpp) {
  const n = line.length
  if (f === 1) for (let i = bpp; i < n; i++) line[i] = (line[i] + line[i - bpp]) & 255
  else if (f === 2) for (let i = 0; i < n; i++) line[i] = (line[i] + prev[i]) & 255
  else if (f === 3) for (let i = 0; i < n; i++) line[i] = (line[i] + (((i >= bpp ? line[i - bpp] : 0) + prev[i]) >> 1)) & 255
  else if (f === 4) for (let i = 0; i < n; i++) {
    const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
    line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
  }
}

function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 2
  const idat = []
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8)
    const d = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9] }
    else if (type === 'IDAT') idat.push(d)
    else if (type === 'IEND') break
    p += 12 + len
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 1
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * bpp
  const rgb = Buffer.alloc(w * h * 3)
  let prev = Buffer.alloc(stride), q = 0
  for (let y = 0; y < h; y++) {
    const f = raw[q++]
    const line = Buffer.from(raw.subarray(q, q + stride)); q += stride
    unfilter(f, line, prev, bpp)
    for (let x = 0; x < w; x++) {
      const s = x * bpp, d = (y * w + x) * 3
      rgb[d] = line[s]; rgb[d + 1] = line[s + 1]; rgb[d + 2] = line[s + 2]
    }
    prev = line
  }
  return { w, h, rgb }
}

const imgs = shots.map((f) => decodePng(readFileSync(f)))
const { w: GW, h: GH } = imgs[0]

// ── 5. 全局调色板（中位切分）──────────────────────────────────────────────────
const hist = new Map()
for (const im of imgs)
  for (let i = 0; i < im.rgb.length; i += 3) {
    const k = (im.rgb[i] << 16) | (im.rgb[i + 1] << 8) | im.rgb[i + 2]
    hist.set(k, (hist.get(k) || 0) + 1)
  }
const uniq = [...hist.entries()].map(([k, n]) => [(k >> 16) & 255, (k >> 8) & 255, k & 255, n])

function medianCut(colors, max) {
  let boxes = [colors]
  while (boxes.length < max) {
    let bi = -1, bs = 0
    boxes.forEach((b, i) => {
      if (b.length < 2) return
      let s = 0
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0
        for (const p of b) { if (p[c] < lo) lo = p[c]; if (p[c] > hi) hi = p[c] }
        s = Math.max(s, hi - lo)
      }
      if (s > bs) { bs = s; bi = i }
    })
    if (bi < 0 || bs === 0) break
    const b = boxes[bi]
    let ch = 0, best = 0
    for (let c = 0; c < 3; c++) {
      let lo = 255, hi = 0
      for (const p of b) { if (p[c] < lo) lo = p[c]; if (p[c] > hi) hi = p[c] }
      if (hi - lo > best) { best = hi - lo; ch = c }
    }
    b.sort((x, y) => x[ch] - y[ch])
    const mid = b.length >> 1
    boxes.splice(bi, 1, b.slice(0, mid), b.slice(mid))
  }
  return boxes.map((b) => {
    let r = 0, g = 0, bl = 0, n = 0
    for (const p of b) { r += p[0] * p[3]; g += p[1] * p[3]; bl += p[2] * p[3]; n += p[3] }
    return n ? [Math.round(r / n), Math.round(g / n), Math.round(bl / n)] : [0, 0, 0]
  })
}

const palette = uniq.length <= 256 ? uniq.map((c) => [c[0], c[1], c[2]]) : medianCut(uniq, 256)
const cache = new Map()
const nearest = (r, g, b) => {
  const k = (r << 16) | (g << 8) | b
  let v = cache.get(k)
  if (v !== undefined) return v
  let bi = 0, bd = Infinity
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i], d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2
    if (d < bd) { bd = d; bi = i }
  }
  cache.set(k, bi); return bi
}

// ── 6. GIF89a + LZW ──────────────────────────────────────────────────────────
function lzw(minCode, idx) {
  const CLEAR = 1 << minCode, EOI = CLEAR + 1
  let size = minCode + 1, next = EOI + 1
  let dict = new Map(), acc = 0, bits = 0
  const bytes = []
  const emit = (code) => {
    acc |= code << bits; bits += size
    while (bits >= 8) { bytes.push(acc & 255); acc >>= 8; bits -= 8 }
  }
  emit(CLEAR)
  let prefix = idx[0]
  for (let i = 1; i < idx.length; i++) {
    const k = idx[i], key = prefix * 4096 + k
    const hit = dict.get(key)
    if (hit !== undefined) { prefix = hit; continue }
    emit(prefix)
    if (next < 4096) dict.set(key, next++)
    if (next > (1 << size) && size < 12) size++
    else if (next >= 4096) { emit(CLEAR); dict = new Map(); size = minCode + 1; next = EOI + 1 }
    prefix = k
  }
  emit(prefix); emit(EOI)
  if (bits > 0) bytes.push(acc & 255)
  return bytes
}

const buf = []
const push = (...b) => buf.push(...b)
const u16 = (n) => push(n & 255, (n >> 8) & 255)

push(...Buffer.from('GIF89a'))
u16(GW); u16(GH)
push(0xf7, 0, 0)                                   // GCT 256 色
for (let i = 0; i < 256; i++) { const c = palette[i] || [0, 0, 0]; push(c[0], c[1], c[2]) }
push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0)   // 无限循环

for (let fi = 0; fi < imgs.length; fi++) {
  const im = imgs[fi]
  const idx = new Uint8Array(GW * GH)
  for (let i = 0, j = 0; i < im.rgb.length; i += 3, j++)
    idx[j] = nearest(im.rgb[i], im.rgb[i + 1], im.rgb[i + 2])
  push(0x21, 0xf9, 4, 0); u16(frames[fi].delay); push(0, 0)          // 图形控制扩展
  push(0x2c); u16(0); u16(0); u16(GW); u16(GH); push(0)              // 图像描述符
  push(8)
  const data = lzw(8, idx)
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.slice(i, i + 255)
    push(chunk.length, ...chunk)
  }
  push(0)
}
push(0x3b)

const gif = Buffer.from(buf)
writeFileSync(join(ROOT, argv.includes('--only-last') ? 'demo-last.gif' : 'demo.gif'), gif)
console.error(`✅ ${argv.includes('--only-last') ? 'demo-last.gif' : 'demo.gif'}  ${GW}x${GH}  ${imgs.length} 帧  ${(gif.length / 1024).toFixed(0)}KB  调色板 ${palette.length} 色（原始 ${uniq.length} 色）`)
