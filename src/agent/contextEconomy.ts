/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { Step, ToolCall } from "./types";

/**
 * Token economy for long agent traces.
 *
 * Keep durable task state: user messages, assistant text (not thinking),
 * todos, task/subagent results, edit receipts, Q&A, mode/plan changes.
 *
 * Drop bulk file bodies: Read/Grep/search dumps and full edit payloads become
 * short path + size / +N -M stubs. Live turn (last user message onward) stays
 * verbatim so mid-task work is not forgotten.
 */

/** Exploration / dump tools — full body rarely needed once out of the recent window. */
const STALEABLE = new Set([
  "Read",
  "Grep",
  "Glob",
  "SemanticSearch",
  "SearchDocs",
  "ListDir",
  "FileSearch",
  "WebFetch",
  "WebSearch",
  "Shell",
  "AwaitShell",
  "ReadLints",
  "ListMcpResources",
  "FetchMcpResource",
  "CallMcpTool",
]);

/**
 * Tools whose output is *evidence*, not a dump: build/test/lint results are the
 * reason the agent is doing what it's doing, and a bare "re-call if needed" stub
 * both loses the failure and provokes an expensive re-run. Keep a short tail
 * instead — far cheaper than re-running the command.
 */
const TAIL_KEEP = new Set(["Shell", "AwaitShell", "ReadLints"]);

/** Lines / chars retained when tail-keeping a result. */
const TAIL_LINES = 24;
const TAIL_CHARS = 1600;

/** Durable task state — never stub results (already short or must stay visible). */
const PROTECTED_RESULTS = new Set([
  "TodoWrite",
  "TodoRead",
  "Task",
  "AskQuestion",
  "SwitchMode",
  "WritePlan",
  "StrReplace",
  "Write",
  "Delete",
  "EditNotebook",
]);

/** Edit payloads: once applied in an OLDER turn, re-sending full strings is waste. */
const SLIM_ARGS = new Set(["StrReplace", "Write", "EditNotebook", "Delete"]);

const PRUNE_MARK = "[context pruned]";

/** Keep this many most-recent dump results verbatim from *before* the live turn. */
const KEEP_RECENT_DUMPS = 4;

/** Keep this many most-recent assistant tool-call batches (pre-live) with full args. */
const KEEP_RECENT_CALL_BATCHES = 4;

/** Only prune dump results larger than this (chars). */
const MIN_PRUNE_CHARS = 400;

/** Default verbatim recent-work window (tokens) when no budget is supplied. */
const DEFAULT_KEEP_RECENT_TOKENS = 12_000;

/** The over-budget pass keeps a much smaller verbatim window. */
const HARD_KEEP_RECENT_TOKENS = 4_000;

function isPruned(s: string): boolean {
  return s.startsWith(PRUNE_MARK);
}

function lineCount(s: string): number {
  if (!s) return 0;
  return s.split(/\r?\n/).length;
}

/** +added -removed line estimate from before/after snippets. */
function lineDelta(before: string, after: string): string {
  const b = lineCount(before);
  const a = lineCount(after);
  const plus = Math.max(0, a - b);
  const minus = Math.max(0, b - a);
  // When lengths match, still note a same-size replace.
  if (plus === 0 && minus === 0) {
    return b <= 1 ? `~${before.length}→${after.length}ch` : `~${b} lines rewritten`;
  }
  return `+${plus} -${minus}`;
}

function argPath(a: Record<string, unknown>): string {
  for (const k of ["path", "target_notebook", "target_directory", "url", "file"]) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** One-line stub for dump tool results — path + size, no file body. */
function stubDumpResult(name: string, output: string, status: string, argsHint?: string): string {
  const n = output.length;
  const lines = output.split(/\r?\n/).length;
  const pathFromOut =
    /(?:^|\n)(?:file|path)["']?\s*[:=]\s*["']?([^\s"']+)/i.exec(output)?.[1] ||
    /(?:^|\n)([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]{1,12})(?:\n|:|\s\|)/.exec(output)?.[1] ||
    "";
  const where = (argsHint || pathFromOut || "").slice(0, 120);
  const err =
    status === "error" || /^error:/i.test(output)
      ? ` · ${(output.split(/\r?\n/)[0] || "").slice(0, 160)}`
      : "";
  return `${PRUNE_MARK} ${name}${where ? ` · ${where}` : ""} · ${lines} lines · ${n} chars · ${status}.${err} Re-call if needed.`;
}

/** Keep the tail of an evidence result (errors, test/build output) plus a header. */
function tailResult(name: string, output: string, status: string, argsHint?: string): string {
  const lines = output.split(/\r?\n/);
  let tail = lines.slice(-TAIL_LINES).join("\n");
  if (tail.length > TAIL_CHARS) tail = tail.slice(-TAIL_CHARS);
  const omitted = Math.max(0, lines.length - TAIL_LINES);
  const head = `${PRUNE_MARK} ${name}${argsHint ? ` · ${argsHint.slice(0, 120)}` : ""} · ${status} · last ${Math.min(TAIL_LINES, lines.length)} of ${lines.length} lines${omitted ? ` (${omitted} earlier omitted)` : ""}:`;
  return `${head}\n${tail}`;
}

/** Rough token estimate (~4 chars/token) for one step, images priced realistically. */
export function stepTokens(s: Step): number {
  let chars = 0;
  if (s.kind === "user") {
    chars += s.text.length;
    for (const a of s.attachments || []) chars += a.kind === "image" ? 0 : a.data?.length || 0;
    const imgs = (s.attachments || []).filter((a) => a.kind === "image").length;
    return Math.ceil(chars / 4) + imgs * IMAGE_TOKENS + 4;
  }
  if (s.kind === "assistant") {
    // thinking is UI-only — never sent on the wire (see buildMessages).
    chars += s.text?.length || 0;
    for (const c of s.calls || []) chars += (c.arguments?.length || 0) + (c.name?.length || 0) + 8;
    return Math.ceil(chars / 4) + 4;
  }
  chars += s.output?.length || 0;
  return Math.ceil(chars / 4) + (s.image ? IMAGE_TOKENS : 0) + 4;
}

/** Total rough token estimate for a step list. */
export function stepsTokens(steps: Step[]): number {
  return steps.reduce((n, s) => n + stepTokens(s), 0);
}

/** A rendered image costs far more than its base64 length suggests. */
const IMAGE_TOKENS = 1300;

/** Index of the last real (non-synthetic) user message — the actual request. */
export function lastRealUserIndex(steps: Step[]): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.kind === "user" && !s.synthetic) return i;
  }
  return lastUserIndex(steps);
}

/** The user's current request text, used to anchor the durable state block. */
export function currentRequestText(steps: Step[]): string {
  const i = lastRealUserIndex(steps);
  const s = steps[i];
  return s && s.kind === "user" ? s.text : "";
}

/**
 * Start of the verbatim "recent work" window: walk back from the end until
 * `keepTokens` is used. Everything before it may be pruned, including work from
 * the current user turn — a long agentic run is one turn, so bounding the window
 * by the last user message (as this used to) meant never pruning at all.
 */
export function recentWindowStart(steps: Step[], keepTokens: number): number {
  let used = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    used += stepTokens(steps[i]);
    if (used > keepTokens) return i + 1;
  }
  return 0;
}

/** Compact edit tool args: path + line stats, no code bodies. */
function slimEditArgs(name: string, args: string): string {
  try {
    const a = JSON.parse(args || "{}") as Record<string, unknown>;
    const path = argPath(a);
    if (name === "Delete") {
      return JSON.stringify({ path: path || a.path, _pruned: "deleted" });
    }
    if (name === "Write") {
      const contents = typeof a.contents === "string" ? a.contents : "";
      return JSON.stringify({
        path,
        _pruned: `wrote ${lineCount(contents)} lines (${contents.length} chars)`,
      });
    }
    if (name === "StrReplace") {
      const oldS = typeof a.old_string === "string" ? a.old_string : "";
      const newS = typeof a.new_string === "string" ? a.new_string : "";
      const out: Record<string, unknown> = {
        path,
        _pruned: `edit ${lineDelta(oldS, newS)}`,
      };
      if (a.replace_all || a.allow_multiple_matches) out.replace_all = true;
      return JSON.stringify(out);
    }
    if (name === "EditNotebook") {
      const oldS = typeof a.old_string === "string" ? a.old_string : "";
      const newS = typeof a.new_string === "string" ? a.new_string : "";
      return JSON.stringify({
        target_notebook: a.target_notebook,
        cell_idx: a.cell_idx,
        is_new_cell: a.is_new_cell,
        cell_language: a.cell_language,
        _pruned: a.is_new_cell ? `new cell (${lineCount(newS)} lines)` : `edit ${lineDelta(oldS, newS)}`,
      });
    }
  } catch {
    /* fall through */
  }
  return args.slice(0, 200) + `…[+${Math.max(0, args.length - 200)} chars pruned]`;
}

function slimCallArgs(name: string, args: string): string {
  if (!args) return args;
  if (SLIM_ARGS.has(name)) {
    // Always collapse edit bodies once outside the recent window — even small ones.
    if (args.length < 80 && name === "Delete") return args;
    return slimEditArgs(name, args);
  }
  if (name.startsWith("mcp__") && args.length >= MIN_PRUNE_CHARS) {
    try {
      const parsed = JSON.parse(args);
      return JSON.stringify(slimGeneric(parsed));
    } catch {
      return args.slice(0, 300) + `…[+${args.length - 300} chars pruned]`;
    }
  }
  // Non-edit tools: hard cap only if enormous.
  if (args.length < 2000) return args;
  return args.slice(0, 400) + `…[+${args.length - 400} chars pruned]`;
}

function slimGeneric(v: unknown, depth = 0): unknown {
  if (depth > 4) return "…";
  if (typeof v === "string") {
    if (v.length <= 200) return v;
    return `${v.slice(0, 200)}…[+${v.length - 200} chars]`;
  }
  if (Array.isArray(v)) {
    if (v.length > 8) return [...v.slice(0, 6).map((x) => slimGeneric(x, depth + 1)), `…(+${v.length - 6})`];
    return v.map((x) => slimGeneric(x, depth + 1));
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) {
      if (/^(path|id|callId|name|command|pattern|query|url)$/i.test(k) && typeof val === "string" && val.length < 500) {
        out[k] = val;
      } else {
        out[k] = slimGeneric(val, depth + 1);
      }
    }
    return out;
  }
  return v;
}

/** Tools whose repeat calls on the same target supersede older results (latest wins). */
const DEDUP_TOOLS = new Set(["Read", "ListDir", "ReadLints", "Glob", "Grep", "SemanticSearch", "WebFetch", "TodoRead"]);

/** Stable dedup key for a tool call: name + primary target extracted from args. */
function dedupKey(name: string, args: string): string | undefined {
  if (!DEDUP_TOOLS.has(name)) return undefined;
  try {
    const a = JSON.parse(args || "{}") as Record<string, unknown>;
    const target = a.path ?? a.target_directory ?? a.url ?? a.glob_pattern ?? a.pattern ?? a.query;
    if (typeof target !== "string" || !target) return name === "TodoRead" ? name : undefined;
    const range = a.offset != null || a.limit != null ? `#${a.offset ?? ""}:${a.limit ?? ""}` : "";
    return `${name}:${target}${range}`;
  } catch {
    return undefined;
  }
}

function callArgsById(steps: Step[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of steps) {
    if (s.kind !== "assistant") continue;
    for (const c of s.calls || []) m.set(c.id, c.arguments || "");
  }
  return m;
}

/**
 * Latest-wins dedup: older duplicate Reads/etc become one-line supersede stubs.
 * Never touches the live turn.
 */
function dedupeRepeatedResults(steps: Step[], liveFrom: number): number {
  const keyByCallId = new Map<string, string>();
  for (const s of steps) {
    if (s.kind !== "assistant") continue;
    for (const c of s.calls || []) {
      const k = dedupKey(c.name, c.arguments || "");
      if (k) keyByCallId.set(c.id, k);
    }
  }
  const lastIdxByKey = new Map<string, number>();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== "tool-result") continue;
    const k = keyByCallId.get(s.callId);
    if (k) lastIdxByKey.set(k, i);
  }
  let deduped = 0;
  for (let i = 0; i < liveFrom; i++) {
    const s = steps[i];
    if (s.kind !== "tool-result" || s.image) continue;
    if (PROTECTED_RESULTS.has(s.name) && s.name !== "TodoRead") continue;
    const k = keyByCallId.get(s.callId);
    if (!k || lastIdxByKey.get(k) === i) continue;
    if (isPruned(s.output) || s.output.length < 120) continue;
    // Errors are evidence: a failed read/command that a later call repeated is
    // exactly the thing the agent is reacting to, so keep its tail.
    if (s.status === "error") {
      steps[i] = { ...s, output: tailResult(s.name, s.output, s.status, k.slice(k.indexOf(":") + 1)) };
      deduped++;
      continue;
    }
    steps[i] = {
      ...s,
      output: `${PRUNE_MARK} ${s.name} · ${k.slice(k.indexOf(":") + 1).slice(0, 120)} · superseded by a newer ${s.name} of the same target below — use that result.`,
    };
    deduped++;
  }
  return deduped;
}

function lastUserIndex(steps: Step[]): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === "user") return i;
  }
  return 0;
}

function isStaleableResult(name: string): boolean {
  if (PROTECTED_RESULTS.has(name)) return false;
  return STALEABLE.has(name) || name.startsWith("mcp__");
}

/** Evidence results keep a tail instead of collapsing to a one-line stub. */
function keepsTail(name: string, status: string): boolean {
  return TAIL_KEEP.has(name) || status === "error";
}

/**
 * In-place history shrink for the model wire.
 * Never mutates the live turn (last user message onward).
 * Never drops assistant text, todos, edits, or task results — only dump bodies.
 */
export function economizeHistory(steps: Step[], opts?: { keepRecentTokens?: number }): { prunedResults: number; slimmedCalls: number } {
  let prunedResults = 0;
  let slimmedCalls = 0;
  if (steps.length < 4) {
    // Still strip thinking (UI-only) everywhere.
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.kind === "assistant" && s.thinking) steps[i] = { ...s, thinking: undefined };
    }
    return { prunedResults, slimmedCalls };
  }

  // The live window is the recent work, never "everything since the last user
  // message": loop-injected nudges used to move that boundary and instantly
  // collapse the work the agent was in the middle of.
  const liveFrom = recentWindowStart(steps, opts?.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS);
  const argsByCall = callArgsById(steps);

  // 0) Latest-wins dedup only outside the recent window.
  prunedResults += dedupeRepeatedResults(steps, liveFrom);

  // 1) Stub dump tool bodies from older turns. Keep a small recent dump window.
  const dumpIdxs: number[] = [];
  for (let i = 0; i < liveFrom; i++) {
    const s = steps[i];
    if (s.kind === "tool-result" && isStaleableResult(s.name)) dumpIdxs.push(i);
  }
  const keepDumpsFrom =
    dumpIdxs.length <= KEEP_RECENT_DUMPS ? 0 : dumpIdxs[dumpIdxs.length - KEEP_RECENT_DUMPS];

  for (let i = 0; i < liveFrom; i++) {
    const s = steps[i];
    if (s.kind !== "tool-result") continue;
    if (!isStaleableResult(s.name)) continue;
    if (i >= keepDumpsFrom) continue;
    if (isPruned(s.output) || s.output.length < MIN_PRUNE_CHARS) continue;
    if (s.image) continue;
    let pathHint = "";
    try {
      pathHint = argPath(JSON.parse(argsByCall.get(s.callId) || "{}") as Record<string, unknown>);
    } catch {
      /* ignore */
    }
    steps[i] = {
      ...s,
      output: keepsTail(s.name, s.status)
        ? tailResult(s.name, s.output, s.status, pathHint)
        : stubDumpResult(s.name, s.output, s.status, pathHint),
    };
    prunedResults++;
  }

  // 2) Slim old edit-arg payloads from older turns only (path + +/- stats).
  const callBatchIdxs: number[] = [];
  for (let i = 0; i < liveFrom; i++) {
    const s = steps[i];
    if (s.kind === "assistant" && s.calls.length) callBatchIdxs.push(i);
  }
  const keepCallsFrom =
    callBatchIdxs.length <= KEEP_RECENT_CALL_BATCHES
      ? Infinity
      : callBatchIdxs[callBatchIdxs.length - KEEP_RECENT_CALL_BATCHES];

  for (let i = 0; i < liveFrom; i++) {
    const s = steps[i];
    if (s.kind !== "assistant" || !s.calls?.length) continue;
    if (i >= keepCallsFrom) continue;
    let changed = false;
    const next: ToolCall[] = s.calls.map((c) => {
      const slim = slimCallArgs(c.name, c.arguments || "");
      if (slim !== c.arguments) {
        changed = true;
        slimmedCalls++;
        return { ...c, arguments: slim };
      }
      return c;
    });
    // Keep assistant text; drop thinking (UI-only).
    if (changed) {
      steps[i] = { ...s, calls: next, thinking: undefined };
    } else if (s.thinking) {
      steps[i] = { ...s, thinking: undefined };
    }
  }

  // Thinking is UI-only — drop from model wire copy everywhere (not persisted).
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind === "assistant" && s.thinking) {
      steps[i] = { ...s, thinking: undefined };
    }
  }

  return { prunedResults, slimmedCalls };
}

/**
 * Extra pass when still over budget: stub ALL pre-live dump results (no recent
 * window), then slim ALL pre-live edit args. Does not drop steps or assistant text.
 */
export function economizeHistoryHard(steps: Step[], opts?: { keepRecentTokens?: number }): void {
  const liveFrom = recentWindowStart(steps, opts?.keepRecentTokens ?? HARD_KEEP_RECENT_TOKENS);
  const argsByCall = callArgsById(steps);
  for (let i = 0; i < liveFrom; i++) {
    const s = steps[i];
    if (s.kind === "tool-result" && isStaleableResult(s.name) && !s.image && !isPruned(s.output) && s.output.length >= 80) {
      let pathHint = "";
      try {
        pathHint = argPath(JSON.parse(argsByCall.get(s.callId) || "{}") as Record<string, unknown>);
      } catch {
        /* ignore */
      }
      steps[i] = {
        ...s,
        output: keepsTail(s.name, s.status)
          ? tailResult(s.name, s.output, s.status, pathHint)
          : stubDumpResult(s.name, s.output, s.status, pathHint),
      };
    }
    if (s.kind === "assistant" && s.calls?.length) {
      let changed = false;
      const next = s.calls.map((c) => {
        if (!SLIM_ARGS.has(c.name) && !c.name.startsWith("mcp__")) return c;
        const slim = slimCallArgs(c.name, c.arguments || "");
        if (slim !== c.arguments) {
          changed = true;
          return { ...c, arguments: slim };
        }
        return c;
      });
      if (changed || s.thinking) steps[i] = { ...s, calls: next, thinking: undefined };
    }
  }
}

/** True if a step is durable task state that budget-trim must prefer to keep. */
export function isProtectedStep(s: Step): boolean {
  if (s.kind === "user") return true;
  if (s.kind === "assistant") {
    // Assistant text or non-dump tool calls (todos/edits/tasks) are durable.
    if ((s.text || "").trim()) return true;
    return (s.calls || []).some((c) => PROTECTED_RESULTS.has(c.name) || SLIM_ARGS.has(c.name));
  }
  return PROTECTED_RESULTS.has(s.name);
}

/** Hard safety trigger. Normal compaction waits for a semantic boundary. */
export const COMPACT_AT_FILL = 0.78;

/** Soft boundary trigger — wait longer so mid-task work isn't summarized away. */
export const COMPACT_SOFT_FILL = 0.65;

/**
 * After summarize, keep this fraction of budget as verbatim tail. Kept well under
 * the soft trigger so a compaction actually buys room — at 0.5 the very next step
 * was back at the threshold and re-summarized on every turn.
 */
export const COMPACT_KEEP_FRAC = 0.35;

/** Skip compaction unless the summarized prefix frees at least this much budget. */
export const COMPACT_MIN_GAIN_FRAC = 0.12;

/** Minimum steps between two compactions, so a run can't summarize in a loop. */
export const COMPACT_COOLDOWN_STEPS = 6;

/** Safe boundary: the model just completed a subtask instead of being mid-tool loop. */
export function isCompactionBoundary(steps: Step[]): boolean {
  const last = steps[steps.length - 1];
  if (!last) return false;
  if (last.kind === "assistant" && !!last.text.trim() && !last.calls.length) return true;
  // Loop-injected messages (subagent reports, nudges) land between turns, which
  // is exactly a safe place to compact.
  if (last.kind === "user") return last.synthetic === true;
  return false;
}
