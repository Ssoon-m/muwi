// muwi integration for oh-my-pi (managed by muwi; do not edit, run muwi setup again)
// MUWI_INTEGRATION_ID=omp
//
// Install path: ~/.omp/agent/extensions/muwi.ts (auto-discovered, no config entry).
// OMP imports this file with Bun and calls the default export with its ExtensionAPI. The
// same factory is bound again for every subagent session; `ctx.agent.kind` tells them apart.
// Every event is turned into Claude-Code-shaped hook JSON and piped to the muwi hook script.
// Nothing here may break OMP: every handler swallows its own errors. This matters most for
// `tool_call`, where an error or a timeout blocks the tool.
// @ts-nocheck
import { spawn } from "node:child_process";
import path from "node:path";

const ID = "omp";
const MUWI_HOOK = "__MUWI_HOOK__";
const TIMEOUT_MS = 5000;
const CONTEXT_TYPE = "muwi-context";

// Module-level state is shared by the main session's binding and all subagent bindings.
const root: { sessionId?: string; cwd?: string } = {};
const runningSubagents = new Set<string>();

// ---------------------------------------------------------------- hook process

// Runs `__MUWI_HOOK__ <id> [mode]`, writes the payload to stdin and resolves with the parsed
// stdout JSON. Resolves with {} on any failure, non-JSON output, or after 5 seconds.
function runHook(mode: string | undefined, payload: unknown): Promise<any> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value && typeof value === "object" ? value : {});
    };
    let child: any;
    try {
      child = spawn(MUWI_HOOK, mode ? [ID, mode] : [ID], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      finish({});
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish({});
    }, TIMEOUT_MS);
    let out = "";
    child.stdout?.on("data", (chunk: unknown) => {
      out += chunk;
    });
    child.stdout?.on("error", () => {});
    child.on("error", () => finish({}));
    child.on("close", () => {
      const text = out.trim();
      if (!text) return finish({});
      try {
        finish(JSON.parse(text));
      } catch {
        finish({});
      }
    });
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.end(JSON.stringify(payload));
    } catch {}
  });
}

function contextOf(reply: any): string | undefined {
  const text = reply?.hookSpecificOutput?.additionalContext;
  return typeof text === "string" && text.trim() ? text : undefined;
}

function decisionOf(reply: any) {
  const out = reply?.hookSpecificOutput ?? {};
  return {
    decision: typeof out.permissionDecision === "string" ? out.permissionDecision : undefined,
    reason: typeof out.permissionDecisionReason === "string" ? out.permissionDecisionReason : undefined,
    context: contextOf(reply),
  };
}

// ---------------------------------------------------------------- normalizing

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value) return value;
  return undefined;
}

// "[src/a.ts#1A2B]" (hashline section header) -> "src/a.ts"
function plainPath(value: string | undefined): string | undefined {
  if (!value) return value;
  const match = value.match(/^\[(.+?)(?:#[0-9A-Fa-f]+)?\]$/);
  return match ? match[1] : value;
}

// First file named in an edit payload: a hashline "[PATH#TAG]" section or "*** Update File: path".
function editPath(a: any): string | undefined {
  const direct = firstString(a.path, Array.isArray(a.paths) ? a.paths[0] : undefined, a.file_path);
  if (direct) return plainPath(direct);
  const text = firstString(a.input, a.patch, a.patchText);
  if (!text) return undefined;
  const hashline = text.match(/^\[(.+?)#[0-9A-Fa-f]+\]\s*$/m);
  if (hashline) return hashline[1];
  const patch = text.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m);
  return patch ? patch[1].trim() : undefined;
}

// "src/a.ts:50-100" / "src/a.ts:raw" -> "src/a.ts" (read accepts a trailing selector)
function withoutSelector(file: string): string {
  return file.replace(/(?::(?:raw|img|conflicts|[-L0-9,.+]+))+$/, "");
}

// OMP tool names: bash, edit (apply_patch in that edit mode), write, read, task.
// OMP has no skill tool: a skill is loaded with `read skill://<name>` or by reading SKILL.md.
function normalizeTool(toolName: unknown, input: any) {
  const a = input && typeof input === "object" ? input : {};
  switch (toolName) {
    case "bash":
      return { name: "Bash", input: { command: firstString(a.command) ?? "" } };
    case "edit":
    case "apply_patch":
      return { name: "Edit", input: { file_path: editPath(a) } };
    case "write":
      return { name: "Write", input: { file_path: plainPath(firstString(a.path, a.file_path)) } };
    case "read": {
      const target = firstString(a.path, a.file_path);
      if (target?.startsWith("skill://")) {
        return { name: "Skill", input: { skill: target.slice("skill://".length).split(/[/:]/)[0] } };
      }
      const file = target ? withoutSelector(target) : target;
      if (file && path.basename(file) === "SKILL.md") {
        return { name: "Skill", input: { skill: path.basename(path.dirname(file)), file_path: file } };
      }
      return { name: "Read", input: { file_path: file } };
    }
    case "task": {
      // Batch shape { context, tasks: [...] } or flat shape { agent, task, ... }.
      const first = Array.isArray(a.tasks) && a.tasks.length ? a.tasks[0] : a;
      const type = firstString(first?.agent, a.agent) ?? "task";
      return {
        name: "Agent",
        input: {
          subagent_type: type,
          description: firstString(first?.name, a.name),
          prompt: firstString(first?.task, a.task, Array.isArray(first?.steps) ? first.steps[0] : undefined),
          count: Array.isArray(a.tasks) ? a.tasks.length : undefined,
        },
      };
    }
    default:
      return undefined;
  }
}

function modeFor(name: string): string | undefined {
  if (name === "Bash") return "command"; // links a node a subagent starts; never blocks
  // Edits and subagent spawns are not reported: muwi never blocks what the agent does.
  return undefined;
}

// `session_start` carries no reason, so a launch with a resume flag is read from argv.
function launchedWithResume(): boolean {
  const args = process.argv.slice(2);
  const end = args.indexOf("--");
  const flags = end === -1 ? args : args.slice(0, end);
  return flags.some((arg) => /^(?:--resume|--session|--continue|--restore|-r|-c)(?:=|$)/.test(arg));
}

// ---------------------------------------------------------------- extension

export default function (pi: any) {
  // SessionStart context waiting for the next prompt (`session_start` has no result type).
  let pendingStart: string | undefined;
  // `before_agent_start` may be called again for the same submission; reuse the first answer.
  let lastPrompt: { prompt: string; at: number; content: string | undefined } | undefined;

  const isSub = (ctx: any) => ctx?.agent?.kind === "sub";

  const ownSessionId = (ctx: any): string | undefined => {
    try {
      return ctx?.sessionManager?.getSessionId?.();
    } catch {
      return undefined;
    }
  };

  const subagentId = (ctx: any) => String(ctx?.agent?.id ?? ownSessionId(ctx) ?? "subagent");

  // Events inside a subagent are reported under the main session id, with agent_id set.
  const base = (ctx: any, event: string, extra?: Record<string, unknown>) => {
    const own = ownSessionId(ctx);
    const sub = isSub(ctx);
    if (!sub && own) {
      root.sessionId = own;
      root.cwd = firstString(ctx?.cwd) ?? root.cwd;
    }
    const payload: Record<string, unknown> = {
      hook_event_name: event,
      session_id: sub ? (root.sessionId ?? own) : own,
      cwd: firstString(ctx?.cwd, root.cwd) ?? process.cwd(),
      model: firstString(ctx?.model?.id),
      ...extra,
    };
    if (sub) {
      payload.agent_id = subagentId(ctx);
      payload.agent_type = firstString(ctx?.agent?.name) ?? "subagent";
    }
    return payload;
  };

  const subagentStart = async (ctx: any) => {
    const id = subagentId(ctx);
    if (runningSubagents.has(id)) return;
    runningSubagents.add(id);
    await runHook(undefined, base(ctx, "SubagentStart"));
  };

  const subagentStop = async (ctx: any) => {
    const id = subagentId(ctx);
    if (!runningSubagents.delete(id)) return;
    await runHook(undefined, base(ctx, "SubagentStop"));
  };

  const sessionStart = async (ctx: any, source: string) => {
    pendingStart = contextOf(await runHook(undefined, base(ctx, "SessionStart", { source }))) ?? pendingStart;
  };

  pi.on("session_start", async (_event: any, ctx: any) => {
    try {
      if (isSub(ctx)) return await subagentStart(ctx);
      await sessionStart(ctx, launchedWithResume() ? "resume" : "startup");
    } catch {}
  });

  // /new, /resume, /fork inside a running process.
  pi.on("session_switch", async (event: any, ctx: any) => {
    try {
      if (isSub(ctx)) return;
      pendingStart = undefined;
      await sessionStart(ctx, event?.reason === "new" ? "startup" : "resume");
    } catch {}
  });

  pi.on("session_compact", async (_event: any, ctx: any) => {
    try {
      if (isSub(ctx)) return;
      await sessionStart(ctx, "compact");
    } catch {}
  });

  // UserPromptSubmit. Context injection: the returned `message` is a custom message that OMP
  // appends once after the prompt and sends to the model (hidden in the transcript view).
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      if (isSub(ctx)) return void (await subagentStart(ctx)); // covers a revived subagent
      if (event?.reason && event.reason !== "prompt") return;
      const prompt = firstString(event?.prompt) ?? "";
      let content: string | undefined;
      if (lastPrompt && lastPrompt.prompt === prompt && Date.now() - lastPrompt.at < 3000) {
        content = lastPrompt.content;
      } else {
        const reply = await runHook(undefined, base(ctx, "UserPromptSubmit", { prompt }));
        const parts = [pendingStart, contextOf(reply)].filter(Boolean);
        pendingStart = undefined;
        content = parts.length ? parts.join("\n\n") : undefined;
        lastPrompt = { prompt, at: Date.now(), content };
      }
      if (content) return { message: { customType: CONTEXT_TYPE, content, display: false } };
    } catch {}
  });

  // PreToolUse. Denial: `{ block: true, reason }`; the reason is returned to the model.
  // Context from a nudge goes back as `additionalContext`, which OMP delivers after the
  // tool results, before the next model request.
  pi.on("tool_call", async (event: any, ctx: any) => {
    try {
      if (isSub(ctx)) await subagentStart(ctx);
      const tool = normalizeTool(event?.toolName, event?.input);
      if (!tool) return;
      const mode = modeFor(tool.name);
      if (!mode) return;
      const reply = await runHook(
        mode,
        base(ctx, "PreToolUse", { tool_name: tool.name, tool_input: tool.input, tool_use_id: event?.toolCallId }),
      );
      const result = decisionOf(reply);
      if (result.decision === "deny") return { block: true, reason: result.reason || "Blocked by muwi" };
      if (result.context) return { additionalContext: result.context };
    } catch {}
  });

  // PostToolUse, for Read and Skill only.
  pi.on("tool_result", async (event: any, ctx: any) => {
    try {
      const tool = normalizeTool(event?.toolName, event?.input);
      if (!tool || (tool.name !== "Read" && tool.name !== "Skill")) return;
      await runHook(
        undefined,
        base(ctx, "PostToolUse", { tool_name: tool.name, tool_input: tool.input, tool_use_id: event?.toolCallId }),
      );
    } catch {}
  });

  // OMP has no subagent-stop event. The end of the subagent's own agent loop is the closest
  // signal; `willContinue` marks an end that is followed by an automatic continuation.
  pi.on("agent_end", async (event: any, ctx: any) => {
    try {
      if (isSub(ctx) && event?.willContinue !== true) await subagentStop(ctx);
    } catch {}
  });

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    try {
      if (isSub(ctx)) await subagentStop(ctx);
    } catch {}
  });
}
