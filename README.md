# ctxdu

**`du` for your Claude Code context window.**

When your disk fills up you don't want to be told "5% free" — you want to know which directory
is eating 80GB. Claude Code tells you the percentage. `ctxdu` tells you what's in there.

![demo](demo.gif)

## Why

Three complaints, one root cause:

- *"Why is it compacting again?"*
- *"Did it forget what I said earlier?"*
- *"Why did this session cost so much?"*

The context window filled up — and you have no idea what filled it. `ctxdu` reads the session
transcript Claude Code already writes to disk and gives you an itemised bill.

## Install

It's a single file with **zero dependencies**. Clone it and link it:

```sh
git clone https://github.com/richardysx/ctxdu.git
cd ctxdu && npm link          # puts `ctxdu` on your PATH
```

Or skip the install and run the file directly: `node /path/to/ctxdu/ctxdu.mjs`.

Requires Node 18+. (Not published to npm yet, so `npx ctxdu` will not work.)

## Usage

> **Run it inside a directory where you have actually used Claude Code.**
> `ctxdu` locates transcripts by the current working directory, so running it in a
> fresh clone or an unrelated folder finds nothing. If that happens it prints the
> directories on your machine that do have sessions, so you can cd into one.

```sh
ctxdu                 # most recent session in this project
ctxdu 065b346b        # a specific session (prefix of the session id)
ctxdu --json          # machine-readable output
ctxdu --lang zh       # 中文输出
ctxdu --mcp           # which MCP servers are configured vs actually used
ctxdu --mcp --probe   # connect to each server and measure its real schema cost
```

## What it measures

| Bucket | Precision | What you can do about it |
|---|---|---|
| **fixed overhead** | exact | Almost nothing — see below |
| **model thinking** | **exact** (`thinking_tokens`) | Lower the thinking effort for routine work |
| model reply | estimated | — |
| **tool call args** | estimated | Stop inlining long scripts; write them to a file and run that |
| **tool results** | estimated, attributed per file/command/query | Narrow noisy output (`\| tail -50`), avoid re-reading files |
| your input | estimated | — |
| system injected | estimated | — |

Every finding it prints is tied to an action. If there's nothing you can do, it says so
instead of padding the report:

```
!  of the 28,034 fixed overhead you control only 1,042 (3.7%) — the rest is
   system-fixed, do not spend time here
```

## Three things measuring real sessions turned up

**1. You start tens of thousands of tokens in the hole.** Before you type a character, the
system prompt, built-in tool schemas, `CLAUDE.md` and skills listing are already resident.
Across independent interactive sessions on one machine this measured **27,000–28,100 tokens,
13.5%–14.1% of a 200k window** — and only ~4% of it was under the user's control, so `ctxdu`
tells you to stop looking there.

The number is not universal: it tracks whatever tool and skill set your session loads. The
same machine in non-interactive `-p` mode measured **11,263**. Run `ctxdu` and read your own
figure rather than trusting this one — that is the entire point of the tool.

**2. Model thinking is ~20–24% of used context** in substantive sessions. One fifth of your
window is the model thinking to itself. That one is adjustable.

**3. Tool call *arguments* can outweigh tool *results*.** This is the counterintuitive one.
Everyone assumes the expensive part is what tools return — file contents, command output.
In a scripting-heavy session the measured split was **63,035 tokens of arguments against
28,565 of results**: the long heredocs and inline scripts the agent writes are pasted into
the transcript and then sit in context forever. Write the script to a file and run the file.

## MCP servers

MCP tool schemas ship with *every* request and stay resident in context — and nothing tells
you what they cost. `ctxdu --mcp` cross-references the servers you have configured against
the ones you've actually called:

```
  server      calls    used     last          schema
  postgres        0       0        -   ...never called
  github         42       6   2026-09-02
```

Add `--probe` and it performs a real MCP handshake (`initialize` → `tools/list`) against each
stdio server and reports the measured schema size, so "you have three servers you never call"
becomes "removing them frees N tokens on every single turn".

## How it works

The interesting part is that **`ctxdu` never counts tokens itself** — estimating tokens by
character count was measured to be ~22% off, which is useless at this resolution.

Instead it differences the usage numbers the API already reports:

```
context_total = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
delta_i       = context_total_i - context_total_(i-1)      # exact tokens added this turn
new_input_i   = delta_i - output_tokens_(i-1)              # exact, minus what the model wrote
```

Turn-level attribution is therefore **exact with no tokenizer**; only the split *within* a
turn is proportional. The accounting self-checks: bucket totals reconcile with the reported
context to within 1 token (rounding).

Five things in the transcript format will silently corrupt this if you don't handle them:

1. **One API call spans multiple JSONL rows.** Thinking, text and each `tool_use` get their
   own line sharing a `requestId` — and *every one of them repeats the same `usage` object*.
   In one session 107 assistant rows were 37 real API calls. Difference them row-by-row and
   most deltas come out zero.
2. **Sessions chain across files.** `resume`/`continue` starts a new transcript whose first
   row points at the previous one via `parentUuid`. `ctxdu` walks the chain back; if the
   earlier file is gone it says the baseline is unreliable rather than reporting a wrong number.
3. **The window size isn't in the transcript.** `model` reads `claude-opus-5` whether the
   session ran with a 200k or 1M window, so it's inferred from the observed peak.
4. **Compaction.** A negative delta means the window was compacted; accumulation resets there.
5. **A stray call with no context accounting.** Very rarely a call's `usage` carries none of
   the context fields, so its total reads as zero.The differencing sees a huge negative jump, calls it a
   compaction, resets the baseline to zero, and every later delta lands in one meaningless
   bucket. One row out of 213 was enough to wreck an entire session's numbers. Such calls are
   skipped.

## Accuracy and limits

- Turn-level numbers are exact; within-turn splits are proportional estimates
- Thinking tokens were verified to persist across turns (90 sampled turns, zero contradicting)
- `--probe` supports **stdio** MCP servers only; http/SSE is not implemented yet
- `--probe` really does start those server processes — hence the explicit flag and a 10s timeout
- **Managed connectors are invisible.** Connectors provisioned server-side appear in neither
  the local config nor the transcript (if never called), so `--mcp` only sees locally
  configured servers
- The fixed-overhead breakdown measures `CLAUDE.md`, the memory index and the skills listing;
  everything else is reported as an unmeasurable remainder rather than guessed at

## Privacy

Everything runs locally and reads only files Claude Code already wrote to your disk.
**Nothing is uploaded, ever.** Home-directory paths are redacted to `~` in output so the
report is safe to paste into an issue or a screenshot.

## License

MIT
