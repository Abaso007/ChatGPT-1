/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { safePath, getWorkspaceRoot } from "../../context/workspaceUtils";
import { defineTool } from "./types";
import {
  bgShells,
  nextShellId,
  waitForShell,
  renderShell,
  pushShellOutput,
  getShellSession,
  disposeShellSession,
  detachShellSession,
  type BgShell,
  type ShellNotify,
} from "./shared";
const isWin = process.platform === "win32";
/** Default foreground wait for simple commands; hard max keeps the loop responsive. */
const DEFAULT_BLOCK_MS = 30_000;

const MAX_BLOCK_MS = 30_000;
const MAX_AWAIT_MS = 45_000;
/** Absolute hard wall even if block_until_ms is large / tool timeout is higher. */
const SHELL_HARD_WALL_MS = 45_000;

/** Build a notify_on_output config from the tool input, if present. */
function buildNotify(input: any, ctx: any): ShellNotify | undefined {
  const cfg = input?.notify_on_output;
  if (!cfg || !cfg.pattern) return undefined;
  let re: RegExp;
  try {
    re = new RegExp(String(cfg.pattern));
  } catch {
    return undefined;
  }
  return {
    re,
    reason: String(cfg.reason ?? "output"),
    debounceMs: Math.max(5000, Number(cfg.debounce_ms) || 0),
    lastNotified: 0,
    emit: ctx?.emitShellNotify,
  };
}

// ---- Shell (stateful session; backgrounds a command past block_until_ms) ----
export const runTerminalTool = defineTool("Shell", true, async (input, abortSignal, _callId, ctx) => {
  const root = getWorkspaceRoot();
  const requestedBlock = Number(input.block_until_ms);
  const rawBlock = Number.isFinite(requestedBlock) ? requestedBlock : DEFAULT_BLOCK_MS;
  const blockMs = rawBlock <= 0 ? 0 : Math.min(Math.max(0, rawBlock), MAX_BLOCK_MS);
  const command = String(input.command ?? "").trim();
  if (!command) return { output: "error: command is required" };

  // Prune finished shells older than 10 minutes to bound the registry.
  for (const [k, v] of bgShells) {
    if (v.done && Date.now() - v.startedAt > 600_000) bgShells.delete(k);
  }

  const sessionKey = (ctx as any)?.shellSessionKey ?? "default";
  let session = getShellSession(sessionKey, root);

  // Serialize commands on this session.
  // Always settle the queue slot even if this command errors/times out.
  let releaseQueue!: () => void;
  const prev = session.queue.catch(() => {});
  session.queue = new Promise<void>((r) => {
    releaseQueue = r;
  });
  try {
    let queueTimedOut = false;
    await Promise.race([
      prev,
      new Promise<void>((resolve) => setTimeout(() => {
        queueTimedOut = true;
        resolve();
      }, MAX_BLOCK_MS + 5_000)),
    ]);
    if (queueTimedOut) disposeShellSession(sessionKey);
  } catch {
    disposeShellSession(sessionKey);
  }
  // Never submit into a session whose prior command still owns the protocol.
  session = getShellSession(sessionKey, root);

  const sh: BgShell = {
    id: nextShellId(),
    command,
    proc: session.proc,
    output: "",
    done: false,
    exitCode: null,
    startedAt: Date.now(),
    notify: buildNotify(input, ctx),
  };
  bgShells.set(sh.id, sh);

  const killSession = () => {
    try {
      disposeShellSession(sessionKey, session);
      if (isWin) session.proc.kill();
      else session.proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  };
  const onAbort = () => {
    if (!sh.done) {
      sh.output += "\n(aborted)";
      sh.done = true;
      sh.exitCode = sh.exitCode ?? 130;
    }
    killSession();
  };
  abortSignal?.addEventListener("abort", onAbort);

  let cd = "";
  if (input.working_directory) {
    try {
      cd = safePath(String(input.working_directory));
    } catch (e) {
      abortSignal?.removeEventListener("abort", onAbort);
      sh.done = true;
      sh.exitCode = 1;
      releaseQueue();
      return {
        output: `error: invalid working_directory: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  if (cd) {
    disposeShellSession(sessionKey, session);
    session = getShellSession(sessionKey, cd);
    sh.proc = session.proc;
  }

  let lastSeen = session.buffer.length;
  sh.pump = () => {
    try {
      if (session.buffer.length > lastSeen) {
        pushShellOutput(sh, session.buffer.slice(lastSeen));
        lastSeen = session.buffer.length;
      }
      if (!sh.done && (session.closed || session.proc.killed || session.proc.exitCode != null)) {
        sh.exitCode = session.proc.exitCode ?? 0;
        sh.done = true;
        if (session.error) sh.output += `\n(shell session failed: ${session.error})`;
      }
    } catch (e) {
      if (!sh.done) {
        sh.done = true;
        sh.exitCode = 1;
        sh.output += `\n(pump error: ${e instanceof Error ? e.message : String(e)})`;
      }
    }
  };

  try {
    const stdin = session.proc.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("shell stdin is not writable");
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stdin.removeListener("error", onError);
        error ? reject(error) : resolve();
      };
      const onError = (error: Error) => finish(error);
      const timer = setTimeout(() => finish(new Error("shell write did not complete within 5s")), 5_000);
      stdin.once("error", onError);
      stdin.end(command, () => finish());
    });
  } catch (e) {
    abortSignal?.removeEventListener("abort", onAbort);
    sh.done = true;
    sh.exitCode = 1;
    killSession();
    releaseQueue();
    return {
      output: `error: shell write failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  // Foreground wait expiry returns a background handle; the outer tool budget
  // remains longer so this transition and cleanup cannot race the hard timeout.

  const waitMs = blockMs <= 0 ? 0 : Math.min(blockMs, SHELL_HARD_WALL_MS);
  try {
    await waitForShell(sh, waitMs, undefined, abortSignal);
    try {
      sh.pump?.();
    } catch {
      /* ignore */
    }

    // Abort/timeout: kill session immediately so the loop is free.
    if (abortSignal?.aborted && !sh.done) {
      sh.output += "\n(aborted / timed out)";
      sh.done = true;
      sh.exitCode = sh.exitCode ?? 124;
      killSession();
    } else if (!sh.done) {
      // Foreground expiry is not command failure. Keep capturing delayed stderr
      // (including endpoint-security diagnostics) and let AwaitShell observe it.
      detachShellSession(sessionKey, session);
      const bgPump = setInterval(() => {
        try {
          sh.pump?.();
        } catch {
          /* ignore */
        }
        if (sh.done) clearInterval(bgPump);
      }, 100);
      // A genuinely stuck command remains observable without poisoning the
      // queue forever. Reset only after the background lifetime expires.
      setTimeout(() => {
        if (!sh.done) {
          sh.output += "\n(background limit reached after 10m — shell session reset)";
          sh.done = true;
          sh.exitCode = sh.exitCode ?? 124;
          try {
            if (isWin) session.proc.kill();
            else session.proc.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
        clearInterval(bgPump);
      }, 600_000).unref?.();
    }

    return { output: renderShell(sh) };
  } catch (e) {
    if (!sh.done) {
      sh.done = true;
      sh.exitCode = 1;
      sh.output += `\n(error: ${e instanceof Error ? e.message : String(e)})`;
    }
    killSession();
    return { output: renderShell(sh) };
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
    releaseQueue();
  }
});

// ---- AwaitShell (poll a backgrounded shell, or just sleep) ----
export const awaitShellTool = defineTool("AwaitShell", false, async (input, abortSignal) => {
  const requestedBlock = Number(input?.block_until_ms);
  const raw = Number.isFinite(requestedBlock) ? requestedBlock : 15_000;
  const blockMs = raw <= 0 ? 0 : Math.min(raw, MAX_AWAIT_MS);
  const id = input?.shell_id ? String(input.shell_id) : "";

  if (!id) {
    if (blockMs <= 0) return { output: "error: shell_id is required when block_until_ms is 0" };
    const startedAt = Date.now();
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        abortSignal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => finish();
      const timer = setTimeout(finish, blockMs);
      if (abortSignal?.aborted) finish();
      else abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
    if (abortSignal?.aborted) return { output: `Sleep aborted after ${Date.now() - startedAt}ms.` };
    return { output: `Slept for ${blockMs}ms.` };
  }

  const sh = bgShells.get(id);
  if (!sh) {
    if (/^toolu_|^call_/i.test(id)) {
      return {
        output: `error: "${id}" looks like a subagent/Task call id, not a background shell. Subagents are not shells — do not poll them with AwaitShell.`,
      };
    }
    return { output: `error: no background shell with id ${id}` };
  }

  let pattern: RegExp | undefined;
  if (input?.pattern) {
    try {
      pattern = new RegExp(String(input.pattern), "m");
    } catch (e) {
      return { output: `error: invalid pattern: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  try {
    await waitForShell(sh, blockMs, pattern, abortSignal);
    try {
      sh.pump?.();
    } catch {
      /* ignore */
    }
    return { output: renderShell(sh) };
  } catch (e) {
    return {
      output: `error: AwaitShell failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
});
