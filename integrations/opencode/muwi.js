// muwi integration for OpenCode (managed by muwi; do not edit, run muwi setup again)
// MUWI_INTEGRATION_ID=opencode
//
// Install path: ~/.config/opencode/plugins/muwi.js (auto-discovered, no config entry).
// One default export serves both plugin APIs:
//   - OpenCode V1 (>= 1.18.29) calls `server(input)` and uses the returned hooks object.
//   - OpenCode V2 calls `setup(ctx)` and ignores `server`.
// Every event is turned into Claude-Code-shaped hook JSON and piped to the muwi hook script.
// Nothing here may break OpenCode: every handler swallows its own errors, and the only
// exception that leaves a handler is the deliberate "deny" of a tool call.
import { spawn } from "node:child_process";

const ID = "opencode";
const MUWI_HOOK = "__MUWI_HOOK__";
const TIMEOUT_MS = 5000;
const MAX_TURN_CONTEXT = 8;

// ---------------------------------------------------------------- hook process

// Runs `__MUWI_HOOK__ <id> [mode]`, writes the payload to stdin and resolves with the parsed
// stdout JSON. Resolves with {} on any failure, non-JSON output, or after 5 seconds.
function runHook(mode, payload) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value && typeof value === "object" ? value : {});
    };
    let child;
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
    child.stdout?.on("data", (chunk) => {
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

function contextOf(reply) {
  const text = reply?.hookSpecificOutput?.additionalContext;
  return typeof text === "string" && text.trim() ? text : undefined;
}

function decisionOf(reply) {
  const out = reply?.hookSpecificOutput ?? {};
  return {
    decision: typeof out.permissionDecision === "string" ? out.permissionDecision : undefined,
    reason: typeof out.permissionDecisionReason === "string" ? out.permissionDecisionReason : undefined,
    context: contextOf(reply),
  };
}

// ---------------------------------------------------------------- normalizing

function firstString(...values) {
  for (const value of values) if (typeof value === "string" && value) return value;
  return undefined;
}

// First file named in an apply_patch style payload ("*** Update File: path").
function patchPath(text) {
  if (typeof text !== "string") return undefined;
  const match = text.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m);
  return match ? match[1].trim() : undefined;
}

// Tool names: V1/Kilo use bash, edit, write, apply_patch, read, task, skill.
// V2 uses shell, edit, write, patch, read, subagent, skill.
function normalizeTool(tool, args) {
  const a = args && typeof args === "object" ? args : {};
  const file = firstString(a.filePath, a.file_path, a.path);
  switch (tool) {
    case "bash":
    case "shell":
      return { name: "Bash", input: { command: firstString(a.command) ?? "" } };
    case "edit":
    case "multiedit":
      return { name: "Edit", input: { file_path: file } };
    case "write":
      return { name: "Write", input: { file_path: file } };
    case "apply_patch":
    case "patch":
      return { name: "Edit", input: { file_path: file ?? patchPath(firstString(a.patchText, a.patch, a.input)) } };
    case "read":
      return { name: "Read", input: { file_path: file } };
    case "skill":
      return { name: "Skill", input: { skill: firstString(a.name, a.skill, a.id) } };
    case "task":
    case "subagent": {
      const type = firstString(a.subagent_type, a.agent, a.agentID, a.agent_id, a.name);
      return {
        name: "Agent",
        agentType: type,
        input: { subagent_type: type, description: firstString(a.description), prompt: firstString(a.prompt) },
      };
    }
    default:
      return undefined;
  }
}

function modeFor(name) {
  if (name === "Bash") return "guard";
  if (name === "Edit" || name === "Write" || name === "Agent") return "nudge";
  return undefined;
}

function promptText(parts) {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string" && !part.synthetic)
    .map((part) => part.text)
    .join("\n");
}

function modelName(model) {
  if (!model) return undefined;
  if (typeof model === "string") return model;
  const id = firstString(model.modelID, model.id);
  if (!id) return undefined;
  return model.providerID ? `${model.providerID}/${id}` : id;
}

// ---------------------------------------------------------------- shared state

// Tracks sessions seen by this plugin instance. A session with `parent` is a subagent
// session: its events are reported under the root session id with `agent_id` set.
function createState(defaultCwd) {
  const sessions = new Map();
  const queuedAgentTypes = new Map(); // parent session id -> subagent types waiting for their child session

  const touch = (id) => {
    let session = sessions.get(id);
    if (!session) {
      session = { announced: false, running: false, turnContext: [] };
      sessions.set(id, session);
    }
    return session;
  };

  const rootOf = (id) => {
    const seen = new Set();
    let current = id;
    while (current && !seen.has(current)) {
      seen.add(current);
      const parent = sessions.get(current)?.parent;
      if (!parent) break;
      current = parent;
    }
    return current;
  };

  const isChild = (id) => Boolean(sessions.get(id)?.parent);

  const base = (event, id, extra) => {
    const session = touch(id);
    const rootId = rootOf(id);
    const root = touch(rootId);
    const payload = {
      hook_event_name: event,
      session_id: rootId,
      cwd: firstString(session.cwd, root.cwd, defaultCwd(), process.cwd()),
      model: session.model ?? root.model,
      ...extra,
    };
    if (rootId !== id) {
      payload.agent_id = id;
      payload.agent_type = session.agentType ?? "subagent";
    }
    return payload;
  };

  const addTurnContext = (id, text) => {
    if (!text) return;
    const list = touch(id).turnContext;
    if (list.includes(text)) return;
    list.push(text);
    while (list.length > MAX_TURN_CONTEXT) list.shift();
  };

  // Text to add to the system prompt of every model request of this session:
  // the SessionStart context plus what the current turn collected.
  const contextFor = async (id) => {
    const session = sessions.get(id);
    if (!session) return [];
    if (session.starting) await session.starting;
    return [session.startContext, ...session.turnContext].filter(Boolean);
  };

  const sessionStart = (id, source) => {
    const session = touch(id);
    session.announced = true;
    session.starting = runHook(undefined, base("SessionStart", id, { source })).then((reply) => {
      const text = contextOf(reply);
      if (text) session.startContext = text;
    });
    return session.starting;
  };

  const subagentStart = async (id) => {
    const session = touch(id);
    if (session.running) return;
    session.running = true;
    session.announced = true;
    await runHook(undefined, base("SubagentStart", id));
  };

  const subagentStop = async (id) => {
    const session = sessions.get(id);
    if (!session || !session.running) return;
    session.running = false;
    await runHook(undefined, base("SubagentStop", id));
  };

  const linkChild = (id, parentId) => {
    const session = touch(id);
    if (session.parent || !parentId || parentId === id) return;
    session.parent = parentId;
    const queue = queuedAgentTypes.get(parentId);
    if (queue && queue.length) session.agentType = queue.shift();
  };

  const userPrompt = async (id, text, unseenSource = "resume") => {
    const session = touch(id);
    if (isChild(id)) {
      // The prompt of a subagent session comes from its parent, not from the user.
      await subagentStart(id);
      return;
    }
    // First sight of a session whose creation this plugin did not observe.
    if (!session.announced) await sessionStart(id, unseenSource);
    session.turnContext = [];
    const reply = await runHook(undefined, base("UserPromptSubmit", id, { prompt: text }));
    addTurnContext(id, contextOf(reply));
  };

  // Returns the denial reason, or undefined when the call may run.
  const preTool = async (id, callId, tool, args) => {
    const normalized = normalizeTool(tool, args);
    if (!normalized) return undefined;
    const mode = modeFor(normalized.name);
    if (!mode) return undefined;
    if (isChild(id)) await subagentStart(id); // no-op when already reported
    const reply = await runHook(
      mode,
      base("PreToolUse", id, { tool_name: normalized.name, tool_input: normalized.input, tool_use_id: callId }),
    );
    const result = decisionOf(reply);
    if (result.decision === "deny") return result.reason || "Blocked by muwi";
    // "ask" is ignored: a server plugin has no way to open a confirmation prompt.
    addTurnContext(id, result.context);
    if (normalized.name === "Agent") {
      // Remember the type so the child session created next can be labelled with it.
      const queue = queuedAgentTypes.get(id) ?? [];
      queue.push(normalized.agentType ?? "subagent");
      queuedAgentTypes.set(id, queue);
    }
    return undefined;
  };

  const postTool = async (id, callId, tool, args) => {
    const normalized = normalizeTool(tool, args);
    if (!normalized || (normalized.name !== "Read" && normalized.name !== "Skill")) return;
    await runHook(
      undefined,
      base("PostToolUse", id, { tool_name: normalized.name, tool_input: normalized.input, tool_use_id: callId }),
    );
  };

  const forget = (id) => {
    sessions.delete(id);
    queuedAgentTypes.delete(id);
  };

  return {
    sessions, touch, isChild, linkChild, contextFor, sessionStart, subagentStart, subagentStop,
    userPrompt, preTool, postTool, forget,
  };
}

// ---------------------------------------------------------------- OpenCode V1

// V1 hooks object (@opencode-ai/plugin `Hooks`).
// Context injection: `experimental.chat.system.transform` pushes the text onto the system
// prompt of every model request of the session. Tool denial: throwing from
// `tool.execute.before`; the error message is what the model sees.
const server = async (input) => {
  const state = createState(() => input?.directory);
  const client = input?.client;

  // A session first seen without its `session.created` event (plugin loaded later, resumed
  // session): ask the server once whether it is a child session.
  const resolveParent = async (id) => {
    const session = state.touch(id);
    if (session.parent || session.parentChecked) return;
    session.parentChecked = true;
    try {
      const lookup = client?.session?.get?.({ path: { id } });
      if (!lookup) return;
      const result = await Promise.race([lookup, new Promise((resolve) => setTimeout(resolve, 1500))]);
      const info = result?.data ?? result;
      if (info?.directory) session.cwd = info.directory;
      if (info?.parentID) state.linkChild(id, info.parentID);
    } catch {}
  };

  return {
    event: async ({ event } = {}) => {
      try {
        const type = event?.type;
        const properties = event?.properties ?? {};
        const info = properties.info;
        const id = firstString(properties.sessionID, info?.id);
        if (!type || !id) return;
        if (type === "session.created" || type === "session.updated") {
          const session = state.touch(id);
          session.parentChecked = true;
          if (info?.directory) session.cwd = info.directory;
          if (info?.parentID) state.linkChild(id, info.parentID);
        }
        if (type === "session.created") {
          if (state.isChild(id)) await state.subagentStart(id);
          else if (!state.touch(id).announced) await state.sessionStart(id, "startup");
        } else if (type === "session.compacted") {
          if (!state.isChild(id)) await state.sessionStart(id, "compact");
        } else if (type === "session.idle") {
          if (state.isChild(id)) await state.subagentStop(id);
        } else if (type === "session.status") {
          const status = properties.status;
          const kind = typeof status === "string" ? status : status?.type;
          if (kind === "idle" && state.isChild(id)) await state.subagentStop(id);
        } else if (type === "session.deleted") {
          state.forget(id);
        }
      } catch {}
    },

    "chat.message": async (hookInput, output) => {
      try {
        const id = hookInput?.sessionID;
        if (!id) return;
        const session = state.touch(id);
        const model = modelName(hookInput.model);
        if (model) session.model = model;
        await resolveParent(id);
        await state.userPrompt(id, promptText(output?.parts));
      } catch {}
    },

    "experimental.chat.system.transform": async (hookInput, output) => {
      try {
        const id = hookInput?.sessionID;
        if (!id || !Array.isArray(output?.system)) return;
        for (const text of await state.contextFor(id)) output.system.push(text);
      } catch {}
    },

    "tool.execute.before": async (hookInput, output) => {
      let denied;
      try {
        const id = hookInput?.sessionID;
        if (!id) return;
        await resolveParent(id);
        denied = await state.preTool(id, hookInput.callID, hookInput.tool, output?.args);
      } catch {}
      if (denied) throw new Error(denied);
    },

    "tool.execute.after": async (hookInput) => {
      try {
        const id = hookInput?.sessionID;
        if (!id) return;
        await state.postTool(id, hookInput.callID, hookInput.tool, hookInput.args);
      } catch {}
    },
  };
};

// ---------------------------------------------------------------- OpenCode V2

// V2 plugin (@opencode/plugin `Plugin.define` shape; a plain object is enough).
// Context injection: the `context` session hook pushes a text part onto `event.system`
// before every agent-loop model request. Tool denial: throwing from the `execute.before`
// tool hook. The plugin runs inside OpenCode's shared server process.
async function setup(ctx) {
  const state = createState(() => ctx?.location?.directory);

  const register = async (domain, name, handler) => {
    try {
      await ctx?.[domain]?.hook?.(name, handler);
    } catch {}
  };

  const withTimeout = (promise, ms) =>
    Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);

  // Hooks can run before the `session.created` event reaches the subscription below.
  // For a session not seen yet, ask the server whether it is a child session and whether
  // it already has messages (a session without messages is new, not resumed).
  const resolveUnseen = async (id) => {
    const session = state.touch(id);
    if (session.announced || session.parent || session.checked) return "resume";
    session.checked = true;
    let source = "resume";
    try {
      const info = await withTimeout(ctx.session.get({ sessionID: id }), 1500);
      if (info?.location?.directory) session.cwd = info.location.directory;
      if (info?.parentID) state.linkChild(id, info.parentID);
    } catch {}
    try {
      const messages = await withTimeout(ctx.session.context({ sessionID: id }), 1500);
      if (Array.isArray(messages) && messages.length === 0) source = "startup";
    } catch {}
    return source;
  };

  await register("session", "prompt", async (event) => {
    try {
      const id = event?.sessionID;
      if (!id) return;
      const source = await resolveUnseen(id);
      await state.userPrompt(id, promptText(event.prompt?.text), source);
    } catch {}
  });

  await register("session", "context", async (event) => {
    try {
      const id = event?.sessionID;
      if (!id || !Array.isArray(event.system)) return;
      const model = modelName(event.model);
      if (model) state.touch(id).model = model;
      for (const text of await state.contextFor(id)) event.system.push({ type: "text", text });
    } catch {}
  });

  await register("tool", "execute.before", async (event) => {
    let denied;
    try {
      const id = event?.sessionID;
      if (!id) return;
      await resolveUnseen(id);
      denied = await state.preTool(id, event.id, event.tool, event.input);
    } catch {}
    if (denied) throw new Error(denied);
  });

  await register("tool", "execute.after", async (event) => {
    try {
      const id = event?.sessionID;
      if (!id) return;
      await state.postTool(id, event.id, event.tool, event.input);
    } catch {}
  });

  const controller = new AbortController();
  const types = [
    "session.created",
    "session.compaction.ended",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
    "session.deleted",
  ];
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ types, signal: controller.signal })) {
        try {
          const data = event?.data ?? {};
          const id = data.sessionID;
          if (!id) continue;
          if (event.type === "session.created") {
            const session = state.touch(id);
            if (data.location?.directory) session.cwd = data.location.directory;
            const model = modelName(data.model);
            if (model) session.model = model;
            if (data.parentID) {
              state.linkChild(id, data.parentID);
              if (data.agent && !session.agentType) session.agentType = String(data.agent);
              await state.subagentStart(id);
            } else if (!session.announced) {
              await state.sessionStart(id, "startup");
            }
          } else if (event.type === "session.compaction.ended") {
            if (!state.isChild(id)) await state.sessionStart(id, "compact");
          } else if (event.type === "session.deleted") {
            state.forget(id);
          } else if (state.isChild(id)) {
            await state.subagentStop(id); // session.execution.succeeded / failed / interrupted
          }
        } catch {}
      }
    } catch {}
  })();

  return () => controller.abort();
}

export default { id: "muwi.opencode", server, setup };
