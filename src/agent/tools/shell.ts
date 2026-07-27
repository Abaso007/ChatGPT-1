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
const SENTINEL = "__OC_SHELL_DONE__";
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

/** Quote a filesystem path for the session shell (spaces, quotes, unicode). */
function quotePath(p: string): string {
  if (isWin) {
    // PowerShell single-quoted literal; escape ' by doubling. Drop trailing
    // backslash that would escape the closing quote if we ever used doubles.
    return `'${p.replace(/'/g, "''")}'`;
  }
  // bash: single-quote with '\'' for embedded quotes
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Frame a command so the session ALWAYS prints a sentinel with exit code.
 *
 * Critical: do NOT paste the user command raw into the script. Paths with
 * spaces, unclosed quotes, or bad syntax leave PowerShell waiting for more
 * input forever (no sentinel → tool looks "stuck"). Instead base64-encode the
 * command and Invoke-Expression / bash -c it inside try/catch/finally so
 * parse errors still emit the sentinel and free the session.
 */
function wrapCommand(command: string, cd: string, completionToken: string): string {
  const b64 = Buffer.from(command, "utf8").toString("base64");
  if (isWin) {
    const cdBlock = cd
      ? `Push-Location -LiteralPath ${quotePath(cd)} -ErrorAction Stop; $__oc_pop = $true; `
      : `$__oc_pop = $false; `;
    // Decode → Invoke-Expression inside try; sentinel always in finally.
    // $? / $LASTEXITCODE after IEX covers native cmds and cmdlets.
    return (
      `$__oc_pop = $false; $__oc_ok = $false; $__oc_code = 1; ` +
      `$__oc_old_eap = $ErrorActionPreference; $global:LASTEXITCODE = 0; ` +
      `try { ` +
      `$ErrorActionPreference = 'Stop'; ${cdBlock}` +
      `$__oc_cmd = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')); ` +
      `Invoke-Expression -Command $__oc_cmd; ` +
      `if ($?) { $__oc_ok = $true; $__oc_code = 0 } ` +
      `elseif ($null -ne $LASTEXITCODE -and "$LASTEXITCODE" -ne '') { $__oc_code = [int]$LASTEXITCODE } ` +
      `else { $__oc_code = 1 } ` +
      `} catch { ` +
      `[Console]::Error.WriteLine($_ | Out-String); $__oc_ok = $false; ` +
      `$__oc_code = if ($null -ne $LASTEXITCODE -and "$LASTEXITCODE" -ne '') { [int]$LASTEXITCODE } else { 1 } ` +
      `} finally { ` +
      `if ($__oc_pop) { Pop-Location -ErrorAction SilentlyContinue }; ` +
      `$ErrorActionPreference = $__oc_old_eap; ` +
      `if ($__oc_ok) { [Console]::Out.WriteLine("${completionToken}:0") } ` +
      `else { [Console]::Out.WriteLine("${completionToken}:$__oc_code") } ` +
      `[Console]::Out.Flush(); ` +
      `}\n`
    );
  }
  // bash: decode to a temp eval so spaces/quotes never break the outer script.
  // Always print sentinel even if eval fails (set +e).
  const push = cd ? `pushd ${quotePath(cd)} >/dev/null 2>&1\n__oc_cd_rc=$?\n` : `__oc_cd_rc=0\n`;
  const pop = cd ? `popd >/dev/null 2>&1 || true\n` : "";
  return (
    `set +e\n` +
    `${push}` +
    `if [ "$__oc_cd_rc" -ne 0 ]; then printf '%s\\n' "${completionToken}:1"; else\n` +
    `__oc_cmd=$(printf '%s' '${b64}' | base64 -d 2>/dev/null || printf '%s' '${b64}' | base64 -D 2>/dev/null)\n` +
    `eval "$__oc_cmd"\n` +
    `__oc_rc=$?\n` +
    `${pop}` +
    `printf '%s\\n' "${completionToken}:$__oc_rc"\n` +
    `fi\n`
  );
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

  // Serialize commands on this session so sentinels don't interleave.
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

  const completionToken = `${SENTINEL}_${sh.id}_${Date.now().toString(36)}`;
  const startLen = session.buffer.length;
  let lastSeen = startLen;
  const sentinelRe = new RegExp(`(?:^|\\r?\\n)${completionToken}:(-?\\d+)(?=\\r?\\n|$)`, "m");

  sh.pump = () => {
    try {
      if (session.buffer.length > lastSeen) {
        pushShellOutput(sh, session.buffer.slice(lastSeen));
        lastSeen = session.buffer.length;
      }
      const m = sh.output.match(sentinelRe);
      if (m && !sh.done) {
        sh.exitCode = Number(m[1]);
        sh.done = true;
      }
      // Dead or failed process with no completion record must settle immediately.
      if (!sh.done && (session.closed || session.proc.killed || session.proc.exitCode != null)) {
        sh.exitCode = session.proc.exitCode ?? 1;
        sh.done = true;
        if (session.error) sh.output += `\n(shell session failed: ${session.error})`;
        else sh.output += "\n(shell session exited before command completion)";
      }
    } catch (e) {
      if (!sh.done) {
        sh.done = true;
        sh.exitCode = 1;
        sh.output += `\n(pump error: ${e instanceof Error ? e.message : String(e)})`;
      }
    }
  };

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
  const wrapped = wrapCommand(command, cd, completionToken);

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
      stdin.write(wrapped, (error) => finish(error));
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

    // Strip only this command's framed completion record from rendered output.
    sh.output = sh.output.replace(sentinelRe, "");
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
