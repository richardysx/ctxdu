#!/usr/bin/env node
/**
 * ctxdu — du(1) for the Claude Code context window.
 *
 * 回答一个问题：我的 context 被什么占满了？
 *
 * 核心方法（见 AGENT_VIZ_RESEARCH.md §9）：
 *   - 不自己数 token。相邻两次 API 调用的 context 总量作差，得到该轮新增的精确 token 数。
 *   - 一次 API 调用会被拆成多行 JSONL（thinking/text/每个 tool_use 各一行），
 *     且每行复制同一份 usage —— 必须先按 requestId 聚合，否则差分全错。
 *   - resume/continue 会把对话切到新文件，靠首行 parentUuid 回溯拼接。
 */

import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const ROOT = process.env.CTXDU_HOME || homedir()

// ── 宿主适配 ─────────────────────────────────────────────────────────────────
//
// 分析引擎（差分对账、归因、分桶）与宿主无关，它只要求两件事：
//   1. 能按顺序读到该会话的记录
//   2. 每次 API 调用带有累计 context 总量
//
// 因此支持一个新的 agent harness = 在这里填一个 adapter，分析逻辑一行都不用动。
// 判定标准只有一条：**拿不到 per-call 的 token usage，就做不了**。

/** 递归收集某目录下的全部 .jsonl（无依赖） */
function walkJsonl(dir, out = [], depth = 0) {
  if (depth > 6) return out
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const f = join(dir, e.name)
    if (e.isDirectory()) walkJsonl(f, out, depth + 1)
    else if (e.name.endsWith('.jsonl')) out.push(f)
  }
  return out
}

const HOSTS = {
  'claude-code': {
    label: 'Claude Code',
    projectsDir: join(ROOT, '.claude', 'projects'),
    ext: '.jsonl',
    // 每条记录都带 cwd，据此还原项目真实路径（目录名是路径的横杠形式，不可逆）
    pathOf: (row) => row.cwd,
    // 一次 API 调用会被拆成多行，共享 requestId 且各自复制同一份 usage
    callKey: (row) => row.requestId,
    isCall: (row) => row.type === 'assistant' && row.message?.usage,
    usage: (row) => {
      const u = row.message.usage
      return {
        total: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        output: u.output_tokens || 0,
        thinking: u.output_tokens_details?.thinking_tokens || 0,
        model: row.message.model,
      }
    },
    blocks: (row) => row.message?.content || [],
    // resume/continue 会另起文件，靠首行 parentUuid 回溯
    linkId: (row) => row.uuid,
    parentId: (row) => row.parentUuid,
    listFiles: () => walkJsonl(join(ROOT, '.claude', 'projects')),
    normalize: (rows) => rows,          // 引擎的规范形状就是照它定义的
    chains: true,                       // resume 会跨文件续接
    explainsBaseline: true,             // 固定开销可拆解到 CLAUDE.md / skills
  },

  // ── Codex ──
  // 差异有二：会话按日期铺开而非按项目分目录；token 用量与内容分在不同记录里。
  // 因此 normalize 把它翻译成引擎认识的形状，其余逻辑完全复用。
  codex: {
    label: 'Codex',
    listFiles: () => walkJsonl(join(ROOT, '.codex', 'sessions')),
    pathOf: (row) => (row.type === 'session_meta' ? row.payload?.cwd : null),
    chains: false,                      // 每个会话一个文件
    isCall: (row) => row.type === 'assistant' && row.message?.usage,
    callKey: (row) => row.requestId,
    usage: (row) => {
      const u = row.message.usage
      return { total: u.total || 0, output: u.output || 0, thinking: u.thinking || 0, model: u.model }
    },
    blocks: (row) => row.message?.content || [],
    linkId: () => null,
    parentId: () => null,
    windowOf: (row) => row.message?.usage?.window || 0,

    /**
     * Codex → 规范形状。
     * token_count 事件是一次 API 调用的边界，它之前累积的 response_item 就是这一轮的内容。
     */
    normalize: (rows) => {
      const out = []
      let pending = []
      for (const r of rows) {
        const p = r.payload || {}
        if (r.type === 'session_meta') { out.push({ type: 'session_meta', cwd: p.cwd }); continue }
        if (r.type === 'response_item') {
          if (p.type === 'message' && p.role === 'assistant')
            pending.push({ type: 'text', text: JSON.stringify(p.content ?? '') })
          else if (p.type === 'reasoning')
            pending.push({ type: 'thinking', thinking: JSON.stringify(p.summary ?? '') })
          else if (p.type === 'custom_tool_call')
            pending.push({ type: 'tool_use', id: p.call_id, name: p.name, input: parseInput(p.input) })
          else if (p.type === 'custom_tool_call_output')
            out.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: p.call_id, content: p.output }] } })
          else if (p.type === 'message' && p.role === 'user')
            out.push({ type: 'user', message: { content: JSON.stringify(p.content ?? '') } })
          continue
        }
        if (r.type === 'event_msg' && p.type === 'token_count') {
          const u = p.info?.last_token_usage
          if (!u) continue
          out.push({
            type: 'assistant', requestId: 'ord' + r.ordinal, timestamp: r.timestamp,
            message: {
              model: p.info?.model || 'codex',
              content: pending,
              usage: {
                total: u.input_tokens || 0,              // 已含 cached_input_tokens
                output: u.output_tokens || 0,
                thinking: u.reasoning_output_tokens || 0,
                window: p.info?.model_context_window || 0,
                model: p.info?.model || 'codex',
              },
            },
          })
          pending = []
        }
      }
      return out
    },
  },
}

/** Codex 的工具入参是字符串，尽量解析成对象好让 labelOf 提取文件名/命令 */
function parseInput(x) {
  if (x && typeof x === 'object') return x
  try { const o = JSON.parse(x); return o && typeof o === 'object' ? o : { command: String(x) } }
  catch { return { command: String(x ?? '') } }
}

const HOST_ARG = process.argv.indexOf('--host')
const HOST_ID = (HOST_ARG >= 0 ? process.argv[HOST_ARG + 1] : process.env.CTXDU_HOST) || 'claude-code'
const HOST = HOSTS[HOST_ID] || HOSTS['claude-code']
const PROJECTS = HOST.projectsDir

// ── 读取与拼接 ────────────────────────────────────────────────────────────────

const readJsonl = (f) =>
  readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)

/** 建立 uuid -> {file, idx} 的全局索引，用于跨文件回溯 */
function indexProject(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  const rowsOf = new Map()
  const locate = new Map()
  for (const f of files) {
    const rows = readJsonl(join(dir, f))
    rowsOf.set(f, rows)
    rows.forEach((r, i) => { const id = HOST.linkId(r); if (id) locate.set(id, { file: f, idx: i }) })
  }
  return { rowsOf, locate }
}

/**
 * 从 sessionFile 出发向前拼接完整对话。
 * 返回 { rows, chain, broken } —— broken 表示前史文件已丢失，基线不可信。
 */
function buildChain(dir, sessionFile) {
  const { rowsOf, locate } = indexProject(dir)
  const chain = []
  let file = sessionFile
  let upto = Infinity
  const seen = new Set()
  let broken = false
  let segments = []

  while (file && !seen.has(file)) {
    seen.add(file)
    const rows = (rowsOf.get(file) || []).slice(0, upto === Infinity ? undefined : upto + 1)
    segments.unshift(rows)
    chain.unshift(basename(file, '.jsonl').slice(0, 8))

    const head = rows.find((r) => r.type === 'user' || r.type === 'assistant')
    const parent = head ? HOST.parentId(head) : null
    if (!parent) break
    const loc = locate.get(parent)
    if (!loc) { broken = true; break }   // 前史文件已删除
    file = loc.file
    upto = loc.idx
  }
  return { rows: segments.flat(), chain, broken }
}

// ── API 调用聚合 ──────────────────────────────────────────────────────────────

const ctxTotal = (u) =>
  (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)

/**
 * 把 assistant 行按 requestId 聚合成一次 API 调用。
 * 关键：同 requestId 的多行携带重复 usage，只能算一次。
 */
function collectCalls(rows) {
  const calls = []
  const byReq = new Map()
  rows.forEach((r, i) => {
    if (!HOST.isCall(r)) return
    const key = HOST.callKey(r) || `_${i}`
    if (byReq.has(key)) {
      const c = byReq.get(key)
      c.end = i
      c.blocks.push(...HOST.blocks(r))
      return
    }
    const m = HOST.usage(r)
    const total = m.total
    // 极少数调用的 usage 不带任何 context 字段（总量为 0）。它们不携带 context 信息，
    // 但会让差分看到一次巨大的负跳变，被误判成压缩 —— 一行就能毁掉整份统计。
    if (total <= 0) return
    const c = {
      req: key, start: i, end: i, row: r,
      total,
      output: m.output,
      thinking: m.thinking,
      model: m.model,
      blocks: [...HOST.blocks(r)],
      ts: r.timestamp,
    }
    byReq.set(key, c)
    calls.push(c)
  })
  return calls
}

// ── 归因 ─────────────────────────────────────────────────────────────────────

/** 仅用于轮内按比例拆分，不参与最终数字 */
function est(x) {
  const s = typeof x === 'string' ? x : JSON.stringify(x ?? '')
  let cjk = 0
  for (const ch of s) if (ch >= '一' && ch <= '鿿') cjk++
  return Math.max(1, Math.round(cjk / 1.5 + (s.length - cjk) / 3.6))
}

/** 归因用的唯一标识：必须用完整输入，不能用截断后的 label（否则前缀相同的命令会碰撞） */
function identOf(name, input = {}) {
  const p = input.file_path || input.path || input.notebook_path
  if (p) return p                       // 同一文件的多次读取应当合并 —— 这正是要检测的重复
  const raw = input.command ?? input.query ?? input.pattern ?? input.url ?? input.prompt
  return raw !== undefined ? `#${hash(String(raw))}` : JSON.stringify(input).slice(0, 200)
}

const hash = (s) => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** 剥掉 shell 噪音，露出真正执行的命令 */
function coreCommand(cmd) {
  let s = String(cmd).trim()
  s = s.replace(/^(?:\w+=\S+\s+)+/, '')                    // 前置变量赋值
  s = s.replace(/^cd\s+\S+\s*(?:&&|;)\s*/, '')             // cd xxx &&
  // 取第一条"有信息量"的命令，跳过 echo/cd/mkdir 这类脚手架
  const NOISE = /^(echo|cd|mkdir|export|set|true|:)\b/
  const segs = s.split(/\n|&&|\|\||;/).map((x) => x.trim()).filter(Boolean)
  const first = segs.find((x) => !NOISE.test(x)) || segs[0] || s
  return first.slice(0, 58)
}

/** 从 tool_use 里提取一个人类可读的标签：文件路径 / 命令 / 查询词 */
function labelOf(name, input = {}) {
  // 输出是拿来分享的（issue、截图、README），必须先脱敏。
  // 家目录有两种形态会泄漏用户名：路径本身，以及 project slug 的横杠形式。
  const slug = homedir().replace(/\//g, '-')
  const HOME_MARK = '~'
  const SENSITIVE = /(?:~|\.)?\/?\.(ssh|aws|gnupg|kube|docker)\/[^\s'"]+/g
  const redact = (x) => String(x)
    .split(homedir()).join(HOME_MARK)
    .split(slug).join(HOME_MARK)
    // 凭据目录：文件名本身就可能暴露身份或用途
    .replace(SENSITIVE, (_m, dir) => HOME_MARK + '/.' + dir + '/' + '<redacted>')
    // 命令行里的密钥赋值
    .replace(/\b([A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z_]*)=\S+/gi, '$1=<redacted>')
    // URL query 里常见的 token 参数
    .replace(/([?&])(access_token|api_key|token|key|sig|signature)=[^&\s]+/gi, '$1$2=<redacted>')
  const pick = input.file_path || input.path || input.notebook_path
  if (pick) return redact(pick)
  if (input.command) return redact(coreCommand(input.command))
  if (input.query) return `"${redact(input.query).slice(0, 50)}"`
  if (input.pattern) return `/${input.pattern}/`
  if (input.url) return redact(input.url).slice(0, 60)
  if (input.prompt) return String(input.prompt).slice(0, 50)
  return ''
}

/** 窗口大小无法从 model 字段读出（不带 [1m] 标记），按实测峰值推断 */
function inferWindow(calls) {
  const declared = HOST.windowOf ? Math.max(...calls.map((c) => HOST.windowOf(c.row) || 0)) : 0
  if (declared > 0) return { window: declared, windowInferred: false }
  const peak = Math.max(...calls.map((c) => c.total))
  const TIERS = [200000, 1000000]
  const window = TIERS.find((t) => peak <= t * 0.995) || TIERS[TIERS.length - 1]
  return { window, windowInferred: peak > 200000 }
}

/**
 * 把"助手输出"拆成可行动的三份。
 * thinking 有精确字段；余下按 text / tool_use 的估算比例分配。
 */
function splitOutput(call, actual, add) {
  if (actual <= 0) return
  const ratio = call.output ? actual / call.output : 1
  const think = Math.min(actual, Math.round((call.thinking || 0) * ratio))
  add('thinking', think)

  let rest = actual - think
  if (rest <= 0) return
  const text = call.blocks.filter((b) => b.type === 'text')
  const tool = call.blocks.filter((b) => b.type === 'tool_use')
  const tw = text.reduce((a, b) => a + est(b.text ?? b), 0)
  const uw = tool.reduce((a, b) => a + est(b.input ?? b), 0)
  if (!tw && !uw) { add('reply', rest); return }
  const toolPart = Math.round((uw / (tw + uw)) * rest)
  add('tool-args', toolPart)
  add('reply', rest - toolPart)
}

function analyze(rows, broken = false) {
  const calls = collectCalls(rows)
  if (!calls.length) return null

  // tool_use_id -> {name, label}
  const toolMeta = new Map()
  for (const r of rows) {
    const c = r.message?.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if (b.type === 'tool_use')
        toolMeta.set(b.id, { name: b.name, label: labelOf(b.name, b.input), key: identOf(b.name, b.input) })
    }
  }

  const buckets = new Map()       // 分类 -> token
  const sources = new Map()       // "工具|标签" -> {name,label,tokens,hits}
  const add = (k, n) => buckets.set(k, (buckets.get(k) || 0) + n)
  const addSrc = (key, meta, n) => {
    const s = sources.get(key) || { ...meta, tokens: 0, hits: 0 }
    s.tokens += n; s.hits += 1
    sources.set(key, s)
  }

  // 基线：首次调用的 context 减去它之前的可见内容
  const pre = rows.slice(0, calls[0].start)
  const preEst = pre.reduce((a, r) => a + est(r.message?.content ?? r.attachment ?? ''), 0)
  let baseline = Math.max(0, calls[0].total - preEst)
  let compactions = 0

  add(broken ? '前史内容（不可拆解）' : 'fixed', baseline)
  if (preEst) add('user-input', Math.min(preEst, calls[0].total))

  for (let i = 1; i < calls.length; i++) {
    const prev = calls[i - 1], cur = calls[i]
    const delta = cur.total - prev.total

    if (delta < 0) {           // context 真的缩小了 = 压缩或清空
      compactions++
      buckets.clear(); sources.clear()
      baseline = cur.total
      add('fixed+summary', baseline)
      continue
    }

    // 上一轮的模型输出全额进入 context（已实测：thinking 不被剥离）
    const fromOutput = Math.min(prev.output, delta)
    splitOutput(prev, fromOutput, add)

    // 其余是本轮新进入的输入内容
    let newInput = delta - fromOutput
    if (newInput <= 0) continue

    const between = rows.slice(prev.end + 1, cur.start)
    const parts = []
    for (const r of between) {
      const c = r.message?.content
      if (r.type === 'attachment') { parts.push({ kind: 'system-injected', w: est(r.attachment) }); continue }
      if (r.type === 'system') { parts.push({ kind: 'system-injected', w: est(r.content ?? '') }); continue }
      if (typeof c === 'string') { parts.push({ kind: 'user-input', w: est(c) }); continue }
      if (!Array.isArray(c)) continue
      for (const b of c) {
        if (b.type === 'tool_result') {
          const meta = toolMeta.get(b.tool_use_id) || { name: '?', label: '', key: '?' }
          parts.push({ kind: 'tool-results', w: est(b.content), meta })
        } else {
          parts.push({ kind: 'user-input', w: est(b) })
        }
      }
    }

    const tw = parts.reduce((a, p) => a + p.w, 0)
    if (!tw) { add('system-injected', newInput); continue }
    // 逐项四舍五入会让各份之和不等于 newInput，误差随轮数累积。
    // 把余数补给最大的一份，保证每轮的拆分严格守恒。
    let assigned = 0, biggest = 0
    const shares = parts.map((p, i) => {
      const n = Math.round((p.w / tw) * newInput)
      assigned += n
      if (p.w > parts[biggest].w) biggest = i
      return n
    })
    shares[biggest] += newInput - assigned
    parts.forEach((p, i) => {
      add(p.kind, shares[i])
      if (p.meta) addSrc(`${p.meta.name}|${p.meta.key}`, p.meta, shares[i])
    })
  }

  const last = calls[calls.length - 1]
  const sum = [...buckets.values()].reduce((a, b) => a + b, 0)
  return {
    drift: last.total - sum,
    calls, buckets, sources, baseline, compactions,
    current: last.total, model: last.model,
    ...inferWindow(calls),
  }
}


// ── MCP 归因 ─────────────────────────────────────────────────────────────────
//
// MCP 工具的 schema 常驻在每次请求的 context 里，但用户对此完全无感知。
// 配了却从不调用的 server = 纯浪费，且是能立刻拿回来的 context。
//
// 数据来源分两部分：
//   1. 配置了哪些 server —— 读配置文件（多个标准位置）
//   2. 实际用了哪些      —— 扫全部 transcript 里的 mcp__<server>__<tool> 调用

const MCP_CONFIGS = [
  join(ROOT, '.claude.json'),
  join(ROOT, '.claude', 'settings.json'),
  join(ROOT, '.claude', 'settings.local.json'),
  join(process.cwd(), '.mcp.json'),
  join(process.cwd(), '.claude', 'settings.json'),
  join(process.cwd(), '.claude', 'settings.local.json'),
]

/** 从若干标准位置收集已配置的 MCP server 名 */
function discoverMcpServers() {
  const found = new Map()
  for (const f of MCP_CONFIGS) {
    if (!existsSync(f)) continue
    let cfg
    try { cfg = JSON.parse(readFileSync(f, 'utf8')) } catch { continue }
    const where = f.replace(ROOT, '~')
    // 顶层 mcpServers，以及 projects.<path>.mcpServers 两种布局
    const bags = [cfg.mcpServers]
    for (const proj of Object.values(cfg.projects || {})) bags.push(proj?.mcpServers)
    for (const bag of bags) {
      if (!bag || typeof bag !== 'object') continue
      for (const [name, def] of Object.entries(bag)) {
        if (found.has(name)) continue
        found.set(name, {
          name,
          source: where,
          transport: def?.type || (def?.url ? 'http' : 'stdio'),
          command: def?.command || def?.url || '',
          args: def?.args || [],
        })
      }
    }
  }
  return found
}

/** 扫描全部 transcript，统计每个 MCP server 的真实调用情况 */
function scanMcpUsage(projectsRoot) {
  const usage = new Map()
  let projects = []
  try { projects = readdirSync(projectsRoot) } catch { return usage }
  for (const p of projects) {
    const dir = join(projectsRoot, p)
    let files = []
    try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')) } catch { continue }
    for (const f of files) {
      let rows
      try { rows = readJsonl(join(dir, f)) } catch { continue }
      for (const r of rows) {
        const c = r.message?.content
        if (!Array.isArray(c)) continue
        for (const b of c) {
          if (b.type !== 'tool_use' || !b.name?.startsWith('mcp__')) continue
          const [, server, ...rest] = b.name.split('__')
          const u = usage.get(server) || { server, calls: 0, tools: new Set(), last: null }
          u.calls++
          u.tools.add(rest.join('__'))
          if (r.timestamp && (!u.last || r.timestamp > u.last)) u.last = r.timestamp
          usage.set(server, u)
        }
      }
    }
  }
  return usage
}


/**
 * 连接一个 stdio MCP server，用 JSON-RPC 取回 tools/list，量出 schema 的真实体积。
 * 会真的启动 server 进程，因此只在显式 --probe 时执行。
 */
function probeStdio(def, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(def.command, def.args || [], { stdio: ['pipe', 'pipe', 'ignore'], env: process.env })
    } catch (e) { return resolve({ error: String(e.message || e) }) }

    let buf = ''
    const done = (r) => { clearTimeout(timer); try { child.kill() } catch {} ; resolve(r) }
    const timer = setTimeout(() => done({ error: 'timeout' }), timeoutMs)
    child.on('error', (e) => done({ error: String(e.message || e) }))

    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n') } catch {} }

    child.stdout.on('data', (d) => {
      buf += d.toString()
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' })
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
        } else if (msg.id === 2) {
          const tools = msg.result?.tools || []
          done({ count: tools.length, tokens: est(tools), names: tools.map((t) => t.name) })
        }
      }
    })

    send({ jsonrpc: '2.0', id: 1, method: 'initialize',
           params: { protocolVersion: '2024-11-05', capabilities: {},
                     clientInfo: { name: 'ctxdu', version: '0.1.0' } } })
  })
}

async function probeAll(rows) {
  for (const r of rows) {
    if (r.transport !== 'stdio' || !r.command) { r.probe = { error: t('unsupported', r.transport) }; continue }
    r.probe = await probeStdio(r)
  }
  return rows
}

function mcpReport() {
  const configured = discoverMcpServers()
  const usage = scanMcpUsage(PROJECTS)
  const rows = []
  for (const [name, def] of configured)
    rows.push({ ...def, ...(usage.get(name) || { calls: 0, tools: new Set(), last: null }) })
  // 用过但没在配置里找到的（例如托管连接器），也列出来
  for (const [name, u] of usage)
    if (!configured.has(name)) rows.push({ name, source: '(未在配置文件中找到)', transport: '?', ...u })
  return rows.sort((a, b) => a.calls - b.calls)
}


// ── 固定开销拆解 ──────────────────────────────────────────────────────────────
//
// 基线（~28k）里只有一部分是用户能控制的。策略：能实测的实测，剩下的作为残差
// 归入"系统固定（不可控）"—— 这样每个可控项都是精确的，用户看到就知道能改什么。

function fileTokens(f) {
  try { return est(readFileSync(f, 'utf8')) } catch { return 0 }
}

/** 向上查找各级 CLAUDE.md（全局 + 项目 + 父目录） */
function claudeMdChain(cwd) {
  const hits = []
  const seen = new Set()                      // 同一文件只算一次（向上遍历会再次撞到全局那份）
  const push = (f) => {
    let real
    try { real = realpathSync(f) } catch { return }
    if (seen.has(real)) return
    seen.add(real)
    const t = fileTokens(f)
    if (t) hits.push({ path: f.replace(ROOT, '~'), tokens: t })
  }
  push(join(ROOT, '.claude', 'CLAUDE.md'))
  let d = cwd
  for (let i = 0; i < 6; i++) {
    push(join(d, 'CLAUDE.md'))
    push(join(d, '.claude', 'CLAUDE.md'))
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  return hits
}

/** skills 的清单会被注入：每个 skill 贡献 name + description */
function skillListing() {
  const roots = [
    join(ROOT, '.claude', 'skills'),
    join(ROOT, '.claude', 'plugins', 'cache'),
  ]
  let count = 0, tokens = 0
  const walk = (dir, depth = 0) => {
    if (depth > 5) return
    let ents = []
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const f = join(dir, e.name)
      if (e.isDirectory()) { walk(f, depth + 1); continue }
      if (e.name !== 'SKILL.md') continue
      count++
      // 只有 frontmatter 的 name/description 进清单，正文是按需加载的
      try {
        const head = readFileSync(f, 'utf8').split('---')[1] || ''
        tokens += est(head)
      } catch {}
    }
  }
  for (const r of roots) walk(r)
  return { count, tokens }
}

/** 项目 memory 索引会被注入 */
function memoryTokens(projectDir) {
  const f = join(projectDir, 'memory', 'MEMORY.md')
  return existsSync(f) ? { path: '~/.claude/projects/<proj>/memory/MEMORY.md', tokens: fileTokens(f) } : null
}

function explainBaseline(baseline, projectDir, cwd) {
  const items = []
  // 拆解依赖宿主特有的注入文件（CLAUDE.md、skills 清单…）。
  // 没有为某宿主实现拆解时，宁可整块报作"未拆解"，也不能把别家的文件算进来。
  if (!HOST.explainsBaseline) {
    return { items: [{ label: t('sysPrompt'), tokens: baseline, fixable: false, approx: true }], measured: 0, baseline }
  }
  for (const c of claudeMdChain(cwd)) if (c.tokens) items.push({ label: c.path, tokens: c.tokens, fixable: true })
  const mem = memoryTokens(projectDir)
  if (mem?.tokens) items.push({ label: mem.path, tokens: mem.tokens, fixable: true })
  const sk = skillListing()
  if (sk.tokens) items.push({ label: t('skillListing', sk.count), tokens: sk.tokens, fixable: true })

  const measured = items.reduce((a, i) => a + i.tokens, 0)
  const rest = baseline - measured
  items.push({ label: t('sysPrompt'), tokens: Math.max(0, rest), fixable: false, approx: true })
  return { items, measured, baseline }
}


// ── i18n ─────────────────────────────────────────────────────────────────────
// 默认英文：目标读者是 HN / r/LLMDevs / X 上的开发者。--lang zh 切中文。

const LANG = (process.argv.includes('--lang')
  ? process.argv[process.argv.indexOf('--lang') + 1]
  : process.env.CTXDU_LANG) === 'zh' ? 'zh' : 'en'

const DICT = {
  en: {
    fixed: 'fixed overhead', 'opaque-history': 'prior history (opaque)',
    'fixed+summary': 'fixed + compact summary',
    thinking: 'model thinking', reply: 'model reply', 'tool-args': 'tool call args',
    'tool-results': 'tool results', 'user-input': 'your input', 'system-injected': 'system injected',
    free: 'free', calls: 'API calls', chainLbl: 'session chain',
    brokenWarn: 'earlier session file is gone — fixed-overhead baseline is unreliable',
    compacted: (n) => `${n} compaction(s) detected; showing the last segment only`,
    used: 'used', inferred: ' (inferred from observed peak)',
    baselineHdr: 'Fixed overhead breakdown (spent before you type a single character)',
    youCanFix: '  <- you control this', cannotFix: '  (not controllable)',
    srcHdr: 'Tool results — what is eating your context',
    findHdr: 'Findings',
    fDup: (l, h, t) => `${l} was read ${h} times, costing ${t} tokens — multiple copies of the same content`,
    fDupCmd: (n, l, h, t) => `${n} \`${l}\` ran ${h} times, ${t} tokens total`,
    fBig: (l, p) => `a single source (${l}) accounts for ${p} — consider narrowing its output (e.g. | tail -50)`,
    fBaseline: (t, p) => `fixed overhead is ${t}, ${p} of the window — gone before you type anything`,
    fFixable: (t, f, p) => `of the ${t} fixed overhead you control only ${f} (${p}) — the rest is system-fixed, do not spend time here`,
    fThink: (p) => `model thinking is ${p} of used context — lower the thinking effort for routine work`,
    fArgs: (a, r) => `tool call args (${a}) exceed tool results (${r}) — long scripts are being inlined repeatedly; write them to a file and run that instead`,
    fFull: (p) => `${p} used, close to the auto-compact threshold — consider starting a fresh session`,
    mcpHdr: 'MCP servers (their schemas sit in every request)',
    mcpCalls: 'calls', mcpUsed: 'used', mcpTools: 'tools', mcpLast: 'last',
    mcpNever: ' <- never called', mcpDefined: (n, t) => `  ${n} tools defined · schema ${t} tok`,
    mcpUnknown: (e) => `  schema unknown (${e})`,
    mcpWaste: (t) => `Removing never-called servers frees ${t} tokens — on every single turn`,
    mcpIdle: (n, names) => `${n} server(s) never called: ${names}`,
    mcpIdle2: 'Their tool schemas are still shipped in full on every request.',
    mcpProbeHint: 'For exact cost, enumerate schemas with: ctxdu --mcp --probe (this actually starts those servers)',
    mcpAllUsed: 'All configured servers have actually been called.',
    mcpNone: 'No MCP servers configured, and no MCP calls found in any transcript.',
    mcpLookedIn: (f) => `(config locations checked: ${f})`,
    noSession: 'no analyzable API calls in this session',
    skillListing: (n) => `skills listing (${n})`,
    sysPrompt: 'system prompt + built-in tool schemas',
    noProject: (cwd) => `no Claude Code sessions recorded for this directory:\n    ${cwd}`,
    noProjectHint: '\n  ctxdu reads the transcripts Claude Code writes per project directory.\n  Run it inside a directory where you have actually used Claude Code, e.g.:\n',
    noProjectNone: '\n  No Claude Code sessions were found on this machine at all.\n  Use Claude Code somewhere first, then run ctxdu inside that directory.',
    noSessionFound: (t) => `no session matching "${t}" in this project`,
    unsupported: (t) => `probing ${t} not supported`,
  },
  zh: {
    fixed: '固定开销', 'opaque-history': '前史内容（不可拆解）', 'fixed+summary': '固定开销+压缩摘要',
    thinking: '模型思考', reply: '模型回复', 'tool-args': '工具调用参数',
    'tool-results': '工具返回', 'user-input': '用户输入', 'system-injected': '系统注入',
    free: '剩余可用', calls: '次 API 调用', chainLbl: '会话链',
    brokenWarn: '前史会话文件已丢失，固定开销基线不可信',
    compacted: (n) => `检测到 ${n} 次压缩，仅统计最后一段`,
    used: '总占用', inferred: '（按实测峰值推断）',
    baselineHdr: '固定开销拆解（你还没打第一个字就占掉的部分）',
    youCanFix: '  ← 你可以改', cannotFix: '  （不可控）',
    srcHdr: '工具返回明细（谁在吃 context）',
    findHdr: '发现',
    fDup: (l, h, t) => `${l} 被读取 ${h} 次，占 ${t} token —— 同一份内容的多个副本`,
    fDupCmd: (n, l, h, t) => `${n} \`${l}\` 执行 ${h} 次，累计 ${t} token`,
    fBig: (l, p) => `单个来源 ${l} 占了 ${p}，考虑收窄输出（如 | tail -50）`,
    fBaseline: (t, p) => `开机固定开销 ${t}，占窗口 ${p} —— 你还没打第一个字就没了这些`,
    fFixable: (t, f, p) => `固定开销 ${t} 中你能改的只有 ${f}（${p}）—— 其余是系统固定的，别在这上面花时间`,
    fThink: (p) => `模型思考过程占 ${p} —— 常规任务可调低 thinking 档位换回 context`,
    fArgs: (a, r) => `工具调用参数 ${a} 反超工具返回 ${r} —— 长脚本正被反复内联，改成落盘后执行可省下大半`,
    fFull: (p) => `已用 ${p}，接近自动压缩阈值，考虑现在开新会话`,
    mcpHdr: 'MCP server 使用情况（schema 常驻每次请求的 context）',
    mcpCalls: '调用', mcpUsed: '用过', mcpTools: '个', mcpLast: '最近',
    mcpNever: ' ⚠️ 从未调用', mcpDefined: (n, t) => `  共定义 ${n} 个 · schema ${t} tok`,
    mcpUnknown: (e) => `  schema 未知（${e}）`,
    mcpWaste: (t) => `卸载从未调用的 server 可直接拿回 ${t} token —— 每一轮对话都省`,
    mcpIdle: (n, names) => `${n} 个 server 从未被调用：${names}`,
    mcpIdle2: '它们的工具 schema 仍在每次请求中全量传输。卸载即可直接拿回这部分 context。',
    mcpProbeHint: '精确成本需要连接 server 枚举 schema —— 运行 ctxdu --mcp --probe（会实际启动这些 server）',
    mcpAllUsed: '所有已配置的 server 都被实际调用过。',
    mcpNone: '没有发现已配置的 MCP server，也没有任何 MCP 调用记录。',
    mcpLookedIn: (f) => `（配置文件查找位置：${f}）`,
    noSession: '该会话没有可分析的 API 调用',
    skillListing: (n) => `skills 清单（${n} 个）`,
    sysPrompt: 'system prompt + 内置工具 schema',
    noProject: (cwd) => `这个目录下没有 Claude Code 的会话记录：\n    ${cwd}`,
    noProjectHint: '\n  ctxdu 按项目目录读取 Claude Code 的会话记录。\n  请在你实际用过 Claude Code 的目录里运行，例如：\n',
    noProjectNone: '\n  这台机器上没有找到任何 Claude Code 会话记录。\n  先在某个目录里用一下 Claude Code，再到那个目录运行 ctxdu。',
    noSessionFound: (t) => `本项目中没有匹配 "${t}" 的会话`,
    unsupported: (t) => `不支持探测 ${t}`,
  },
}
const t = (k, ...a) => { const v = DICT[LANG][k]; return typeof v === 'function' ? v(...a) : v }

// ── 渲染 ─────────────────────────────────────────────────────────────────────

const fmt = (n) => n.toLocaleString('en-US')
const wide = (s) => [...s].reduce((n, c) => n + (c > '\u4e00' ? 2 : 1), 0)
const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`
const bar = (n, d, w = 24) => {
  const f = Math.round((n / d) * w)
  return '█'.repeat(Math.max(0, f)) + '░'.repeat(Math.max(0, w - f))
}

function render(a, meta) {
  const { current, window: win } = a
  const free = Math.max(0, win - current)
  const L = ['']
  L.push(`  ctxdu — ${meta.session}  ·  ${a.model || 'unknown'}  ·  ${a.calls.length} ${t('calls')}`)
  if (meta.chain.length > 1) L.push(`  ${t('chainLbl')}: ${meta.chain.join(' -> ')}`)
  if (meta.broken) L.push(`  !  ${t('brokenWarn')}`)
  if (a.compactions) L.push(`  i  ${t('compacted', a.compactions)}`)
  L.push('')
  L.push(`  ${t('used')} ${fmt(current)} / ${fmt(win)}${a.windowInferred ? t('inferred') : ''}   ${pct(current, win)}   ${bar(current, win, 30)}`)
  L.push('')

  const ORDER = ['fixed', 'opaque-history', 'fixed+summary',
                 'thinking', 'reply', 'tool-args', 'tool-results', 'user-input', 'system-injected']
  const order = [...a.buckets.entries()]
    .filter(([, v]) => v > 0)
    .sort((x, y) => {
      const ix = ORDER.indexOf(x[0]), iy = ORDER.indexOf(y[0])
      return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy)
    })
    .map(([k, v]) => [t(k), v])

  const w = Math.max(...order.map(([k]) => wide(k)), wide(t('free')))
  for (const [k, v] of order)
    L.push(`    ${k}${' '.repeat(w - wide(k))}  ${fmt(v).padStart(9)}  ${pct(v, current).padStart(6)}  ${bar(v, current)}`)
  L.push(`    ${t('free')}${' '.repeat(w - wide(t('free')))}  ${fmt(free).padStart(9)}  ${pct(free, win).padStart(6)}`)
  L.push('')

  if (meta.baselineDetail && !meta.broken) {
    const { items } = meta.baselineDetail
    L.push(`  ${t('baselineHdr')}`)
    L.push('')
    const bw = Math.max(...items.map((i) => wide(i.label)))
    const nw = Math.max(...items.map((i) => ((i.approx ? '~' : '') + fmt(i.tokens)).length))
    for (const i of items) {
      const num = (i.approx ? '~' : '') + fmt(i.tokens)
      L.push(`    ${i.label}${' '.repeat(bw - wide(i.label))}  ${num.padStart(nw)}${i.fixable ? t('youCanFix') : t('cannotFix')}`)
    }
    L.push('')
  }

  const top = [...a.sources.values()].sort((x, y) => y.tokens - x.tokens).slice(0, 12)
  if (top.length) {
    L.push(`  ${t('srcHdr')}`)
    L.push('')
    for (const s of top)
      L.push(`    ${fmt(s.tokens).padStart(8)}  ${s.name.padEnd(10)} ${s.label}${s.hits > 1 ? `  x${s.hits}` : ''}`)
    L.push('')
  }

  const finds = []
  const READERS = new Set(['Read', 'NotebookRead', 'Edit', 'Write'])
  for (const d of [...a.sources.values()].filter((s) => s.hits > 1 && s.tokens > 1500 && READERS.has(s.name)).slice(0, 3))
    finds.push(t('fDup', d.label, d.hits, fmt(d.tokens)))
  for (const d of [...a.sources.values()].filter((s) => s.hits > 2 && s.tokens > 2000 && !READERS.has(s.name)).slice(0, 2))
    finds.push(t('fDupCmd', d.name, d.label, d.hits, fmt(d.tokens)))
  const big = top[0]
  if (big && big.tokens / current > 0.1) finds.push(t('fBig', big.label || big.name, pct(big.tokens, current)))
  if (meta.baselineDetail) {
    const fixable = meta.baselineDetail.items.filter((i) => i.fixable).reduce((x, i) => x + i.tokens, 0)
    if (a.baseline && fixable / a.baseline < 0.1)
      finds.push(t('fFixable', fmt(a.baseline), fmt(fixable), pct(fixable, a.baseline)))
  }
  if (!meta.broken && a.baseline / win > 0.12) finds.push(t('fBaseline', fmt(a.baseline), pct(a.baseline, win)))
  const think = a.buckets.get('thinking') || 0
  if (think / current > 0.2) finds.push(t('fThink', pct(think, current)))
  const args = a.buckets.get('tool-args') || 0, ret = a.buckets.get('tool-results') || 0
  if (args > ret && args / current > 0.15) finds.push(t('fArgs', fmt(args), fmt(ret)))
  if (current / win > 0.7) finds.push(t('fFull', pct(current, win)))

  if (finds.length) {
    L.push(`  ${t('findHdr')}`)
    for (const f of finds) L.push(`    !  ${f}`)
    L.push('')
  }
  return L.join('\n')
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/** 流式读取，找到第一条能给出项目路径的记录就停 —— 不整文件解析 */
function projectOfFile(file) {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { const o = JSON.parse(line); const p = HOST.pathOf(o); if (p) return p } catch {}
    }
  } catch {}
  return null
}

let _index = null
/** 全机会话索引：[{ id, file, mtime, project }] */
function sessionIndex() {
  if (_index) return _index
  _index = []
  for (const file of HOST.listFiles()) {
    let mtime = 0
    try { mtime = statSync(file).mtimeMs } catch { continue }
    const project = projectOfFile(file)
    if (!project) continue
    const base = basename(file, '.jsonl')
    const m = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    _index.push({ id: m ? m[0] : base, file, mtime, project })
  }
  _index.sort((a, b) => b.mtime - a.mtime)
  return _index
}

/** 旧接口保留给固定开销拆解用 */
function projectPath(dir) {
  try {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { const o = JSON.parse(line); const p = HOST.pathOf(o); if (p) return p } catch {}
      }
    }
  } catch {}
  return null
}

function knownProjects() {
  const seen = new Map()
  for (const s of sessionIndex()) if (!seen.has(s.project)) seen.set(s.project, { path: s.project, dir: dirname(s.file) })
  return [...seen.values()]
}

/** 挑出要分析的会话：优先当前目录，其次按 id 全局搜索 */
function pickSession(cwd, target, projectOverride) {
  const all = sessionIndex()
  if (!all.length) { const e = new Error(t('noProject', cwd)); e.hint = t('noProjectNone'); throw e }
  const base = projectOverride || cwd
  const local = all.filter((s) => s.project === base || base.startsWith(s.project + '/') || s.project.startsWith(base + '/'))
  if (target) {
    const hit = (local.length ? local : all).find((s) => s.id.startsWith(target) || basename(s.file).includes(target))
      || all.find((s) => s.id.startsWith(target) || basename(s.file).includes(target))
    if (hit) return hit
    const e = new Error(t('noSessionFound', target)); e.hint = ''
    throw e
  }
  if (local.length) return local[0]
  const e = new Error(t('noProject', base))
  e.hint = t('noProjectHint') + '\n' + knownProjects().map((k) => '    cd ' + k.path.replace(homedir(), '~')).join('\n')
  throw e
}

/** 先按 cwd 找；找不到而用户给了会话 id，就在所有项目里搜 */
function findDir(cwd, target) {
  try { return resolveDir(cwd) } catch (e) {
    if (!target) throw e
    for (const p of knownProjects()) {
      try {
        if (readdirSync(p.dir).some((f) => f.endsWith('.jsonl') && f.startsWith(target))) return p.dir
      } catch {}
    }
    throw e
  }
}

function resolveDir(cwd) {
  const slug = cwd.replace(/\//g, '-')
  const d = join(PROJECTS, slug)
  if (existsSync(d)) return d
  let all = []
  try { all = readdirSync(PROJECTS) } catch {}
  const hit = all.find((x) => slug.startsWith(x))
  if (hit) return join(PROJECTS, hit)

  // 不是抛异常了事 —— 告诉用户该去哪里
  const known = knownProjects()
  const err = new Error(t('noProject', cwd))
  err.hint = known.length
    ? t('noProjectHint') + '\n' + known.map((k) => '    cd ' + k.path.replace(homedir(), '~')).join('\n')
    : t('noProjectNone')
  throw err
}

function renderMcp(rows) {
  const L = ['']
  if (!rows.length) {
    L.push(`  ${t('mcpNone')}`)
    L.push(`  ${t('mcpLookedIn', MCP_CONFIGS.map((f) => f.replace(ROOT, '~')).join(', '))}`)
    return L.join('\n') + '\n'
  }
  L.push(`  ${t('mcpHdr')}`)
  L.push('')
  const w = Math.max(...rows.map((r) => r.name.length), 6)
  for (const r of rows) {
    const p = r.probe
    const cost = p ? (p.error ? t('mcpUnknown', p.error) : t('mcpDefined', p.count, fmt(p.tokens))) : ''
    L.push(`    ${r.name.padEnd(w)}  ${t('mcpCalls')} ${String(r.calls).padStart(4)}  ${t('mcpUsed')} ${String(r.tools.size).padStart(2)} ${t('mcpTools')}  ${t('mcpLast')} ${r.last ? r.last.slice(0, 10) : '-'}${cost}${r.calls === 0 ? t('mcpNever') : ''}`)
  }
  const waste = rows.filter((r) => r.calls === 0 && r.probe && !r.probe.error).reduce((a, r) => a + r.probe.tokens, 0)
  if (waste) { L.push(''); L.push(`  >> ${t('mcpWaste', fmt(waste))}`) }
  const idle = rows.filter((r) => r.calls === 0)
  L.push('')
  if (idle.length) {
    L.push(`  !  ${t('mcpIdle', idle.length, idle.map((r) => r.name).join(', '))}`)
    L.push(`     ${t('mcpIdle2')}`)
    if (!rows.some((r) => r.probe)) L.push(`     ${t('mcpProbeHint')}`)
  } else L.push(`  ok ${t('mcpAllUsed')}`)
  return L.join('\n') + '\n'
}

const HELP = `ctxdu — du(1) for the Claude Code context window

USAGE
  ctxdu [session] [options]

  Run it inside the project you want to analyse: ctxdu locates the session
  transcript by the current working directory.

ARGUMENTS
  session            Session id, or any unique prefix of one.
                     Defaults to the most recently modified session.

OPTIONS
  --mcp              Report configured MCP servers vs the ones actually called
  --probe            With --mcp: connect to each stdio server and measure the
                     real schema cost. This actually starts those processes.
  --list             List every project and session on this machine
  --host <name>      Agent harness to read: claude-code (default) or codex
                     (also settable via CTXDU_HOST)
  --project <dir>    Analyse a project directory other than the current one
  --json             Machine-readable output (bucket keys are language-neutral)
  --lang <en|zh>     Output language. Default: en (or $CTXDU_LANG)
  -h, --help         Show this
  -v, --version      Show version

EXAMPLES
  ctxdu                     analyse the newest session in this project
  ctxdu 065b346b            analyse a specific session
  ctxdu --mcp --probe       find MCP servers you configured but never call
  ctxdu --json | jq .buckets

Everything runs locally. Nothing is uploaded. Home paths are redacted to ~.
`

function renderList() {
  const L = ['', `  ${HOST.label}`, '']
  const by = new Map()
  for (const s of sessionIndex()) {
    if (!by.has(s.project)) by.set(s.project, [])
    by.get(s.project).push(s)
  }
  if (!by.size) { L.push('  ' + t('noProjectNone')); return L.join('\n') + '\n' }
  for (const [proj, list] of by) {
    L.push(`  ${proj.replace(homedir(), '~')}`)
    for (const s of list)
      L.push(`      ${s.id.slice(0, 8)}   ${new Date(s.mtime).toISOString().slice(0, 16).replace('T', ' ')}`)
    L.push('')
  }
  return L.join('\n')
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('-h') || args.includes('--help')) return void process.stdout.write(HELP)
  if (args.includes('-v') || args.includes('--version')) {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'))
    return void console.log(pkg.version)
  }
  const json = args.includes('--json')
  if (args.includes('--mcp')) {
    let rows = mcpReport()
    if (args.includes('--probe')) return probeAll(rows).then((r) => {
      console.log(json ? JSON.stringify(r.map((x) => ({ ...x, tools: [...x.tools] })), null, 2) : renderMcp(r))
    })
    if (json) console.log(JSON.stringify(rows.map((r) => ({ ...r, tools: [...r.tools] })), null, 2))
    else console.log(renderMcp(rows))
    return
  }
  if (args.includes('--list')) return void process.stdout.write(renderList())

  const li = args.indexOf('--lang')
  const pi = args.indexOf('--project')
  const hi = args.indexOf('--host')
  const skips = new Set([li >= 0 ? li + 1 : -1, pi >= 0 ? pi + 1 : -1, hi >= 0 ? hi + 1 : -1])
  const target = args.filter((a, i) => !a.startsWith('--') && !skips.has(i))[0]
  const projectOverride = pi >= 0 ? args[pi + 1].replace(/^~/, homedir()) : null

  const pick = pickSession(process.cwd(), target, projectOverride)
  const dir = dirname(pick.file)
  const file = basename(pick.file)

  const loaded = HOST.chains ? buildChain(dir, file) : { rows: readJsonl(pick.file), chain: [pick.id.slice(0, 8)], broken: false }
  const rows = HOST.normalize(loaded.rows)
  const { chain, broken } = loaded
  const a = analyze(rows, broken)
  if (!a) { console.error(t('noSession')); process.exit(1) }
  const baselineDetail = a && !broken ? explainBaseline(a.baseline, dir, process.cwd()) : null

  if (json) {
    console.log(JSON.stringify({
      session: pick.id, chain, broken,
      current: a.current, window: a.window, baseline: a.baseline,
      calls: a.calls.length, compactions: a.compactions,
      buckets: Object.fromEntries(a.buckets),
      baselineDetail,
      sources: [...a.sources.values()].sort((x, y) => y.tokens - x.tokens),
    }, null, 2))
  } else {
    console.log(render(a, { session: pick.id.slice(0, 8), chain, broken, baselineDetail }))
  }
}

try {
  main()
} catch (e) {
  console.error('\nctxdu: ' + (e && e.message ? e.message : String(e)))
  if (e && e.hint) console.error(e.hint)
  console.error('')
  process.exit(1)
}
