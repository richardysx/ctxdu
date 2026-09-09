#!/usr/bin/env node
/**
 * 把 ctxdu 的真实输出渲染成动画 SVG（终端录屏风格）。
 * 零依赖：不需要 vhs / asciinema / ffmpeg，且矢量文字在任何缩放下都清晰。
 * 用法: node tools/make-demo.mjs "<session>" > demo.svg
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const session = process.argv[2] || ''
const out = execFileSync('node', [join(HERE, '..', 'ctxdu.mjs'), ...(session ? [session] : [])],
  { encoding: 'utf8', cwd: process.argv[3] || process.cwd() })

const lines = ['$ npx ctxdu', ...out.replace(/\n+$/, '').split('\n')]

const CW = 8.4, LH = 19, PAD = 22
const cols = Math.max(...lines.map((l) => [...l].length))
const W = Math.ceil(cols * CW + PAD * 2)
const H = Math.ceil(lines.length * LH + PAD * 2 + 26)

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 逐行着色：让关键信息自己跳出来 */
function paint(line, i) {
  const t = esc(line)
  if (i === 0) return `<tspan class="p">$</tspan> <tspan class="cmd">npx ctxdu</tspan>`
  if (/^  ctxdu —/.test(line)) return `<tspan class="hdr">${t}</tspan>`
  if (/^  used /.test(line)) return t
    .replace(/(used)/, '<tspan class="dim">$1</tspan>')
    .replace(/(\d[\d,]*) \/ (\d[\d,]*)/, '<tspan class="big">$1</tspan> <tspan class="dim">/ $2</tspan>')
    .replace(/(\d+\.\d%)/, '<tspan class="warn">$1</tspan>')
    .replace(/(█+)/, '<tspan class="warn">$1</tspan>')
    .replace(/(░+)/, '<tspan class="track">$1</tspan>')
  if (/^  (Fixed overhead|Tool results|Findings|MCP)/.test(line)) return `<tspan class="sect">${t}</tspan>`
  if (/^    !  /.test(line)) return t.replace(/^(\s*)(!)(\s+)(.*)$/, '$1<tspan class="warn">$2</tspan>$3<tspan class="find">$4</tspan>')
  if (/[█░]/.test(line)) return t
    .replace(/(█+)/, '<tspan class="bar">$1</tspan>')
    .replace(/(░+)/, '<tspan class="track">$1</tspan>')
    .replace(/(\d[\d,]{2,})/, '<tspan class="num">$1</tspan>')
  if (/<- you control this/.test(line)) return t.replace(/(&lt;- you control this)/, '<tspan class="ok">$1</tspan>')
  if (/\(not controllable\)/.test(line)) return t.replace(/(\(not controllable\))/, '<tspan class="dim">$1</tspan>')
  return t.replace(/^(\s*)(\d[\d,]*)/, '$1<tspan class="num">$2</tspan>')
}

const HOLD = 7
const TOTAL = (lines.length * 0.055 + HOLD).toFixed(2)
const rows = lines.map((l, i) => {
  const delay = (i * 0.055).toFixed(3)
  return `<text x="${PAD}" y="${PAD + 30 + i * LH}" class="ln" style="animation-delay:${delay}s">${paint(l, i)}</text>`
}).join('\n')

process.stdout.write(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="13">
<style>
  .bg{fill:#0d1117}
  text{fill:#c9d1d9;white-space:pre}
  .ln{opacity:0;animation:in ${TOTAL}s linear infinite}
  @keyframes in{0%{opacity:0}2%{opacity:1}96%{opacity:1}100%{opacity:0}}
  .p{fill:#3fb950}.cmd{fill:#e6edf3;font-weight:600}
  .hdr{fill:#8b949e}.dim{fill:#6e7681}.sect{fill:#e6edf3;font-weight:600}
  .big{fill:#e6edf3;font-weight:600}.num{fill:#79c0ff}
  .bar{fill:#58a6ff}.track{fill:#21262d}.warn{fill:#d29922}
  .find{fill:#f0883e}.ok{fill:#3fb950}
  @media (prefers-reduced-motion:reduce){.ln{animation:none;opacity:1}}
</style>
<rect class="bg" width="100%" height="100%" rx="8"/>
<circle cx="24" cy="20" r="5.5" fill="#ff5f57"/><circle cx="42" cy="20" r="5.5" fill="#febc2e"/><circle cx="60" cy="20" r="5.5" fill="#28c840"/>
${rows}
</svg>
`)
