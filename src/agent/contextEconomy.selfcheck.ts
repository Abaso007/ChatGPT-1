/*
 * Runnable self-check: npx tsx src/agent/contextEconomy.selfcheck.ts
 */
import { economizeHistory, economizeHistoryHard, isProtectedStep } from "./contextEconomy";
import type { Step } from "./types";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const bigFile = "line\n".repeat(200);
const steps: Step[] = [
  { kind: "user", text: "fix auth" },
  {
    kind: "assistant",
    text: "I'll inspect auth and update todos.",
    thinking: "secret chain of thought should not matter",
    calls: [
      { id: "c1", name: "Read", arguments: JSON.stringify({ path: "src/auth.ts" }) },
      {
        id: "c2",
        name: "TodoWrite",
        arguments: JSON.stringify({
          todos: [{ id: "1", content: "Fix login", status: "in_progress" }],
        }),
      },
    ],
  },
  { kind: "tool-result", callId: "c1", name: "Read", output: bigFile, status: "completed" },
  {
    kind: "tool-result",
    callId: "c2",
    name: "TodoWrite",
    output: "Updated todos:\n[~] Fix login",
    status: "completed",
  },
  {
    kind: "assistant",
    text: "Editing login handler.",
    calls: [
      {
        id: "c3",
        name: "StrReplace",
        arguments: JSON.stringify({
          path: "src/auth.ts",
          old_string: "a\n".repeat(40),
          new_string: "b\n".repeat(50),
        }),
      },
    ],
  },
  { kind: "tool-result", callId: "c3", name: "StrReplace", output: "edited src/auth.ts", status: "completed" },
  // Extra dump noise so KEEP window is exceeded
  ...Array.from({ length: 8 }, (_, i): Step[] => [
    {
      kind: "assistant" as const,
      text: "",
      calls: [{ id: `r${i}`, name: "Read", arguments: JSON.stringify({ path: `f${i}.ts` }) }],
    },
    {
      kind: "tool-result" as const,
      callId: `r${i}`,
      name: "Read",
      output: `// file ${i}\n` + bigFile,
      status: "completed" as const,
    },
  ]).flat(),
  { kind: "user", text: "continue" },
  { kind: "assistant", text: "On it.", calls: [] },
];

const before = structuredClone(steps);
const { prunedResults, slimmedCalls } = economizeHistory(steps);

assert(prunedResults > 0, "expected dump results pruned");
// First Read (pre-live, outside recent dump window) should be stubbed
const read0 = steps.find((s) => s.kind === "tool-result" && s.callId === "c1");
assert(read0 && read0.kind === "tool-result", "read0 missing");
assert(read0.output.startsWith("[context pruned]"), `read stub missing: ${read0.output.slice(0, 80)}`);
assert(read0.output.includes("src/auth.ts") || read0.output.includes("Read"), "path/name hint missing");
assert(!read0.output.includes("line\nline\nline"), "full file body still present");

// Todos must survive
const todo = steps.find((s) => s.kind === "tool-result" && s.name === "TodoWrite");
assert(todo && todo.kind === "tool-result", "todo missing");
assert(todo.output.includes("Fix login"), `todo pruned away: ${todo.output}`);

// Assistant text must survive
const a1 = steps.find((s) => s.kind === "assistant" && s.text.includes("inspect auth"));
assert(a1 && a1.kind === "assistant", "assistant text missing");
assert(!a1.thinking, "thinking should be stripped from wire copy");

// Edit result stays
const edit = steps.find((s) => s.kind === "tool-result" && s.name === "StrReplace");
assert(edit && edit.kind === "tool-result" && edit.output.includes("edited"), "edit receipt lost");

// Hard pass slims edit args
economizeHistoryHard(steps);
const editCall = steps.find((s) => s.kind === "assistant" && s.calls?.some((c) => c.id === "c3"));
assert(editCall && editCall.kind === "assistant", "edit call missing");
const args = editCall.calls.find((c) => c.id === "c3")!.arguments;
assert(!args.includes('"old_string"') || args.includes("_pruned"), `edit args not slimmed: ${args}`);
assert(args.includes("src/auth.ts"), "edit path lost");
assert(/\+\d+|\-\d+|edit /.test(args), `expected +/- stats: ${args}`);

assert(isProtectedStep(todo), "TodoWrite should be protected");
assert(isProtectedStep({ kind: "user", text: "x" }), "user protected");

// Live turn not pruned
const live = steps[steps.length - 1];
assert(live.kind === "assistant" && live.text === "On it.", "live turn corrupted");

console.log(`ok pruned=${prunedResults} slimmed=${slimmedCalls} beforeSteps=${before.length}`);
