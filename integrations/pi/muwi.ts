// muwi integration for Pi (managed by muwi; do not edit, run muwi setup again)
// MUWI_INTEGRATION_ID=pi
//
// Install path: ~/.pi/agent/extensions/muwi.ts (auto-discovered, no config entry).
// Pi loads this file with jiti and calls the default export with its ExtensionAPI.
// Every event is turned into Claude-Code-shaped hook JSON and piped to the muwi hook script.
// Nothing here may break Pi: every handler swallows its own errors (a throwing `tool_call`
// handler would block the tool).
// @ts-nocheck
import { spawn } from "node:child_process";
import path from "node:path";

const ID = "pi";
const MUWI_HOOK = "__MUWI_HOOK__";
const TIMEOUT_MS = 5000;
const CONTEXT_TYPE = "muwi-context";

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

// Pi built-in tools: bash (powershell on Windows), read, edit, write. Pi has no skill tool:
// the model loads a skill by reading its SKILL.md, so that read is reported as "Skill".
// Pi has no built-in subagent tool; tools named like one (added by extensions) map to "Agent".
function normalizeTool(toolName: unknown, input: any) {
  const a = input && typeof input === "object" ? input : {};
  const file = firstString(a.path, a.file_path, a.filePath);
  switch (toolName) {
    case "bash":
    case "powershell":
      return { name: "Bash", input: { command: firstString(a.command) ?? "" } };
    case "edit":
      return { name: "Edit", input: { file_path: file } };
    case "write":
      return { name: "Write", input: { file_path: file } };
    case "read":
      if (file && path.basename(file) === "SKILL.md") {
        return { name: "Skill", input: { skill: path.basename(path.dirname(file)), file_path: file } };
      }
      return { name: "Read", input: { file_path: file } };
    case "subagent":
    case "task":
    case "agent": {
      const type = firstString(a.agent, a.subagent_type, a.agentType, a.name);
      return {
        name: "Agent",
        input: { subagent_type: type, description: firstString(a.description), prompt: firstString(a.task, a.prompt) },
      };
    }
    default:
      return undefined;
  }
}

function modeFor(name: string): string | undefined {
  if (name === "Edit" || name === "Write" || name === "Agent") return "nudge";
  return undefined;
}

// ---------------------------------------------------------------- extension

export default function (pi: any) {
  // SessionStart context waiting for the next prompt. `session_start` cannot return anything,
  // so the text is delivered together with the first `before_agent_start` result.
  let pendingStart: string | undefined;

  const base = (ctx: any, event: string, extra?: Record<string, unknown>) => {
    let sessionId: string | undefined;
    try {
      sessionId = ctx?.sessionManager?.getSessionId?.();
    } catch {}
    return {
      hook_event_name: event,
      session_id: sessionId,
      cwd: firstString(ctx?.cwd) ?? process.cwd(),
      model: firstString(ctx?.model?.id),
      ...extra,
    };
  };

  const contextMessage = (content: string) => ({ customType: CONTEXT_TYPE, content, display: false });

  // Adds context while a run is in progress: a custom message queued as a steer is delivered
  // before the next model call and stays in the session. Returns false when Pi refused it.
  const steer = (content: string): boolean => {
    try {
      pi.sendMessage(contextMessage(content), { deliverAs: "steer" });
      return true;
    } catch {
      return false;
    }
  };

  pi.on("session_start", async (event: any, ctx: any) => {
    try {
      const reason = event?.reason; // "startup" | "reload" | "new" | "resume" | "fork"
      if (reason === "reload") return; // same session, only the extension code was reloaded
      const source = reason === "resume" || reason === "fork" ? "resume" : "startup";
      pendingStart = contextOf(await runHook(undefined, base(ctx, "SessionStart", { source })));
    } catch {}
  });

  pi.on("session_compact", async (_event: any, ctx: any) => {
    try {
      const text = contextOf(await runHook(undefined, base(ctx, "SessionStart", { source: "compact" })));
      if (!text) return;
      let idle = true;
      try {
        idle = ctx?.isIdle?.() !== false;
      } catch {}
      // Idle (manual /compact): wait for the next prompt. Mid-run compaction: steer it in.
      if (idle || !steer(text)) pendingStart = text;
    } catch {}
  });

  // UserPromptSubmit. Context injection: the returned `message` is a custom message that Pi
  // stores in the session and sends to the model with this prompt (hidden in the TUI).
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      if (event?.messageType && event.messageType !== "user") return; // run started by an extension message
      const reply = await runHook(undefined, base(ctx, "UserPromptSubmit", { prompt: firstString(event?.prompt) ?? "" }));
      const parts = [pendingStart, contextOf(reply)].filter(Boolean);
      pendingStart = undefined;
      if (parts.length) return { message: contextMessage(parts.join("\n\n")) };
    } catch {}
  });

  // A skill forced with `/skill:name` is expanded by Pi without a tool call; record it here.
  pi.on("input", async (event: any, ctx: any) => {
    try {
      const match = typeof event?.text === "string" ? event.text.match(/^\/skill:([^\s]+)/) : null;
      if (match) {
        await runHook(undefined, base(ctx, "PostToolUse", { tool_name: "Skill", tool_input: { skill: match[1] } }));
      }
    } catch {}
  });

  // PreToolUse. Denial: `{ block: true, reason }`; the reason is returned to the model.
  pi.on("tool_call", async (event: any, ctx: any) => {
    try {
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
      if (result.context) steer(result.context);
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
}
