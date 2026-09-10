#!/usr/bin/env node
/**
 * ctxdu-watch —— 让 agent 自己看见自己的 context 开销。
 *
 * 作为 Claude Code 的 PostToolUse hook 运行：每隔若干次工具调用分析一次，
 * 只在越过阈值时向 agent 注入一句可执行的提醒；其余时候完全沉默。
 *
 * 这是 ctxdu 唯一不需要人在场的用法 —— 人不会在痛的那一刻想起开终端，hook 会。
 *
 * 安装（settings.json）：
 *   "hooks": { "PostToolUse": [ { "hooks": [
 *     { "type": "command", "command": "node <repo>/hook/ctxdu-watch.mjs", "timeout": 15 }
 *   ] } ] }
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const CTXDU = join(HERE, '..', 'ctxdu.mjs')

// hook 每次工具调用都会触发，全量分析会拖慢会话，所以按周期抽样
const EVERY = Number(process.env.CTXDU_WATCH_EVERY || 12)
const WARN_AT = Number(process.env.CTXDU_WATCH_WARN || 0.6)

const input = (() => { try { return JSON.parse(readFileSync(0, 'utf8')) } catch { return {} } })()
const sid = input.session_id || 'unknown'
const state = join(tmpdir(), 'ctxdu-watch', sid + '.json')

function bump() {
  let n = 0
  try { n = JSON.parse(readFileSync(state, 'utf8')).n || 0 } catch {}
  n++
  try { mkdirSync(dirname(state), { recursive: true }); writeFileSync(state, JSON.stringify({ n })) } catch {}
  return n
}

if (bump() % EVERY !== 0) process.exit(0)

let data
try {
  data = JSON.parse(execFileSync('node', [CTXDU, '--json'], {
    encoding: 'utf8', cwd: input.cwd || process.cwd(), timeout: 10000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }))
} catch { process.exit(0) }        // 分析失败就当没发生，绝不打断会话

const { current, window: win, buckets = {} } = data
if (!current || !win) process.exit(0)
const used = current / win
const share = (v) => ((v / current) * 100).toFixed(0) + '%'
const notes = []

if (used >= WARN_AT)
  notes.push(`context is ${(used * 100).toFixed(0)}% full (${current.toLocaleString()}/${win.toLocaleString()})`)

const args = buckets['tool-args'] || 0
const results = buckets['tool-results'] || 0
if (args > results && args / current > 0.15)
  notes.push(`your own tool-call arguments are ${share(args)} of context, more than everything tools have returned (${share(results)}) — you are inlining long scripts; write them to a file and run the file`)

const think = buckets['thinking'] || 0
if (think / current > 0.3) notes.push(`your thinking is ${share(think)} of context`)

const dup = (data.sources || []).filter((s) => s.hits > 1 && s.tokens > 2000).slice(0, 2)
if (dup.length)
  notes.push(`re-read the same source repeatedly: ${dup.map((d) => (d.label || d.name) + ' x' + d.hits).join(', ')} — do not re-read what is already in context`)

if (!notes.length) process.exit(0)  // 没有可行动的事就闭嘴

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: 'ctxdu: ' + notes.join('. ') + '.',
  },
}))
