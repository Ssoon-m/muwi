# muwi integration for Hermes Agent (managed by muwi; do not edit, run muwi setup again)
# MUWI_INTEGRATION_ID=hermes
"""Forward Hermes lifecycle events to muwi as Claude-Code-shaped hook JSON.

Install path: ~/.hermes/plugins/muwi/__init__.py, next to plugin.yaml. Hermes loads the
plugin only when `muwi` is listed under `plugins.enabled` in ~/.hermes/config.yaml
(`hermes plugins enable muwi`).

Nothing here may break Hermes: every callback swallows its own errors. This matters most
for `pre_tool_call`, where a callback that raises or runs past the hook timeout blocks
the tool.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading

_ID = "hermes"
_MUWI_HOOK = "__MUWI_HOOK__"
_TIMEOUT_SECONDS = 5
_SECTION_ID = "muwi.session-context"
_SECTION_MAX_CHARS = 4000
# Local, interactive surfaces. Messaging platforms, cron and kanban workers are ignored.
_INTERACTIVE_PLATFORMS = {"cli", "tui", "desktop", "acp"}
_FULL_COMPACTIONS = {"summarize", "provider_native"}

_lock = threading.RLock()
# session_id -> {"announced": bool, "cwd": str, "model": str, "pending": [str]}
_sessions = {}
# child session_id -> {"root": str, "agent_id": str, "agent_type": str}
_children = {}


# ------------------------------------------------------------------ hook process


def _run_hook(mode, payload):
    """Run the muwi hook script as `<script> hermes [mode]` with the payload on stdin.

    Returns the reply dict.

    Returns {} when the command is missing, fails, prints no JSON, or takes over 5 seconds.
    """
    try:
        argv = [_MUWI_HOOK, _ID] + ([mode] if mode else [])
        options = {
            "input": json.dumps({k: v for k, v in payload.items() if v is not None}),
            "stdout": subprocess.PIPE,
            "stderr": subprocess.DEVNULL,
            "universal_newlines": True,
            "timeout": _TIMEOUT_SECONDS,
            "check": False,
        }
        if os.name == "nt":
            options["creationflags"] = subprocess.CREATE_NO_WINDOW
        output = (subprocess.run(argv, **options).stdout or "").strip()
        if not output:
            return {}
        reply = json.loads(output)
        return reply if isinstance(reply, dict) else {}
    except Exception:
        return {}


def _context_of(reply):
    specific = reply.get("hookSpecificOutput") if isinstance(reply, dict) else None
    text = specific.get("additionalContext") if isinstance(specific, dict) else None
    return text if isinstance(text, str) and text.strip() else None


def _decision_of(reply):
    specific = reply.get("hookSpecificOutput") if isinstance(reply, dict) else None
    if not isinstance(specific, dict):
        return None, None
    decision = specific.get("permissionDecision")
    reason = specific.get("permissionDecisionReason")
    return (
        decision if isinstance(decision, str) else None,
        reason if isinstance(reason, str) and reason else None,
    )


# ------------------------------------------------------------------ state


def _interactive(platform):
    # Hooks that do not pass a platform are not filtered here.
    return platform is None or platform in _INTERACTIVE_PLATFORMS


def _session(session_id):
    with _lock:
        return _sessions.setdefault(session_id, {"announced": False, "pending": []})


def _known(session_id):
    with _lock:
        return session_id in _sessions or session_id in _children


def _is_child(session_id):
    with _lock:
        return session_id in _children


def _payload(event, session_id, **extra):
    """Claude-shaped payload. Events inside a subagent go under the root session id."""
    with _lock:
        child = _children.get(session_id)
        root_id = child["root"] if child else session_id
        state = _sessions.get(root_id, {})
        payload = {
            "hook_event_name": event,
            "session_id": root_id,
            "cwd": state.get("cwd") or os.getcwd(),
            "model": state.get("model"),
        }
        if child:
            payload["agent_id"] = child["agent_id"]
            payload["agent_type"] = child["agent_type"]
    payload.update(extra)
    return payload


def _announce(session_id, source):
    """Send SessionStart once per call and return its additionalContext (or None)."""
    _session(session_id)["announced"] = True
    return _context_of(_run_hook(None, _payload("SessionStart", session_id, source=source)))


def _queue_context(session_id, text):
    if text:
        with _lock:
            _session(session_id)["pending"].append(text)


def _take_context(session_id):
    with _lock:
        state = _session(session_id)
        pending, state["pending"] = state["pending"], []
        return pending


# ------------------------------------------------------------------ normalizing


def _patch_path(text):
    if not isinstance(text, str):
        return None
    match = re.search(r"^\*\*\* (?:Update|Add|Delete) File: (.+)$", text, re.MULTILINE)
    return match.group(1).strip() if match else None


def _first_string(*values):
    for value in values:
        if isinstance(value, str) and value:
            return value
    return None


def _normalize_tool(tool_name, args):
    """Hermes tool names: terminal, write_file, patch, read_file, delegate_task, skill_view."""
    a = args if isinstance(args, dict) else {}
    path = _first_string(a.get("path"), a.get("file_path"))
    if tool_name == "terminal":
        return "Bash", {"command": _first_string(a.get("command")) or ""}, None
    if tool_name == "write_file":
        return "Write", {"file_path": path}, None
    if tool_name == "patch":
        return "Edit", {"file_path": path or _patch_path(_first_string(a.get("patch"), a.get("patch_text")))}, None
    if tool_name == "read_file":
        return "Read", {"file_path": path}, None
    if tool_name == "skill_view":
        return "Skill", {"skill": _first_string(a.get("name"), a.get("skill"))}, None
    if tool_name == "delegate_task":
        tasks = a.get("tasks") if isinstance(a.get("tasks"), list) else []
        first = tasks[0] if tasks and isinstance(tasks[0], dict) else a
        goal = _first_string(first.get("goal"), a.get("goal"))
        agent_type = _first_string(first.get("role"), a.get("role")) or "subagent"
        tool_input = {"subagent_type": agent_type, "description": goal, "prompt": goal}
        if tasks:
            tool_input["count"] = len(tasks)
        return "Agent", tool_input, agent_type
    return None, None, None


def _prompt_text(message):
    if isinstance(message, str):
        return message
    if isinstance(message, list):
        parts = [p.get("text") for p in message if isinstance(p, dict) and isinstance(p.get("text"), str)]
        return "\n".join(parts)
    return ""


# ------------------------------------------------------------------ callbacks


def _system_prompt_section(info):
    """SessionStart for a new session, and the place its context goes.

    Hermes calls this once while it builds the system prompt of a new session, with a
    mapping that includes the session's cwd (hook keyword arguments do not). The returned
    text becomes a system prompt section that Hermes keeps across compaction and resume.
    An empty return makes Hermes skip the section (it logs a warning).
    """
    try:
        session_id = info.get("session_id")
        if not session_id or not _interactive(info.get("platform")) or _is_child(session_id):
            return ""
        state = _session(session_id)
        with _lock:
            state["cwd"] = info.get("cwd") or state.get("cwd")
            state["model"] = info.get("model") or state.get("model")
            already = state["announced"]
        if already:
            return ""
        return (_announce(session_id, "startup") or "")[:_SECTION_MAX_CHARS]
    except Exception:
        return ""


def _on_session_start(session_id=None, model=None, platform=None, **kwargs):
    # New session, first turn. Normally the section callback above has already announced
    # it; this covers Hermes versions without system prompt sections.
    try:
        if not session_id or not _interactive(platform) or _is_child(session_id):
            return
        state = _session(session_id)
        if model:
            state["model"] = model
        if not state["announced"]:
            _queue_context(session_id, _announce(session_id, "startup"))
    except Exception:
        pass


def _on_session_open(session_id=None, platform=None, reason=None, **kwargs):
    # A client reopened a stored session (`hermes --resume`, the session picker).
    try:
        if not session_id or reason != "resume" or not _interactive(platform) or _is_child(session_id):
            return
        _queue_context(session_id, _announce(session_id, "resume"))
    except Exception:
        pass


def _post_compaction(session_id=None, old_session_id=None, kind=None, **kwargs):
    try:
        if not session_id or kind not in _FULL_COMPACTIONS:
            return
        with _lock:
            if old_session_id and old_session_id != session_id and old_session_id in _sessions:
                # The compaction rotated the session id: carry cwd/model over.
                previous = _sessions[old_session_id]
                current = _sessions.setdefault(session_id, {"announced": False, "pending": []})
                current.setdefault("cwd", previous.get("cwd"))
                current.setdefault("model", previous.get("model"))
                for child in _children.values():
                    if child["root"] == old_session_id:
                        child["root"] = session_id
            known = session_id in _sessions
        if known:
            _queue_context(session_id, _announce(session_id, "compact"))
    except Exception:
        pass


def _pre_llm_call(session_id=None, user_message=None, is_first_turn=False, model=None,
                  platform=None, parent_session_id=None, **kwargs):
    """UserPromptSubmit. The returned context is appended to this turn's user message."""
    try:
        if not session_id or not _interactive(platform):
            return None
        if _is_child(session_id) or parent_session_id:
            return None  # a subagent's turn: its prompt comes from the parent, not the user
        state = _session(session_id)
        if model:
            state["model"] = model
        if not state["announced"]:
            # Session not seen by this process yet (older Hermes, or a restarted gateway).
            _queue_context(session_id, _announce(session_id, "startup" if is_first_turn else "resume"))
        reply = _run_hook(None, _payload("UserPromptSubmit", session_id, prompt=_prompt_text(user_message)))
        parts = _take_context(session_id)
        text = _context_of(reply)
        if text:
            parts.append(text)
        return {"context": "\n\n".join(parts)} if parts else None
    except Exception:
        return None


def _pre_tool_call(tool_name=None, args=None, session_id=None, tool_call_id=None, **kwargs):
    """PreToolUse. Deny -> block with the reason."""
    try:
        if not session_id or not _known(session_id):
            return None
        name, tool_input, _agent_type = _normalize_tool(tool_name, args)
        if name == "Bash":
            mode = "command"  # links a node a subagent starts; never blocks
        elif name in ("Edit", "Write", "Agent"):
            mode = "nudge"
        else:
            return None
        reply = _run_hook(mode, _payload("PreToolUse", session_id, tool_name=name,
                                         tool_input=tool_input, tool_use_id=tool_call_id))
        decision, reason = _decision_of(reply)
        if decision == "deny":
            return {"action": "block", "message": reason or "Blocked by muwi"}
        # Context for the model cannot be returned from pre_tool_call; keep it for the next turn.
        with _lock:
            child = _children.get(session_id)
        _queue_context(child["root"] if child else session_id, _context_of(reply))
        return None
    except Exception:
        return None


def _post_tool_call(tool_name=None, args=None, session_id=None, tool_call_id=None, **kwargs):
    """PostToolUse, for Read and Skill only."""
    try:
        if not session_id or not _known(session_id):
            return
        name, tool_input, _agent_type = _normalize_tool(tool_name, args)
        if name in ("Read", "Skill"):
            _run_hook(None, _payload("PostToolUse", session_id, tool_name=name,
                                     tool_input=tool_input, tool_use_id=tool_call_id))
    except Exception:
        pass


def _subagent_start(parent_session_id=None, child_session_id=None, child_subagent_id=None,
                    child_role=None, **kwargs):
    try:
        if not parent_session_id or not _known(parent_session_id):
            return
        key = child_session_id or child_subagent_id
        if not key:
            return
        with _lock:
            parent = _children.get(parent_session_id)
            _children[key] = {
                "root": parent["root"] if parent else parent_session_id,
                "agent_id": str(child_subagent_id or child_session_id),
                "agent_type": child_role or "subagent",
            }
        _run_hook(None, _payload("SubagentStart", key))
    except Exception:
        pass


def _subagent_stop(parent_session_id=None, child_session_id=None, child_role=None,
                   child_status=None, **kwargs):
    try:
        with _lock:
            known_child = child_session_id in _children if child_session_id else False
        if known_child:
            _run_hook(None, _payload("SubagentStop", child_session_id, status=child_status))
            with _lock:
                _children.pop(child_session_id, None)
        elif parent_session_id and _known(parent_session_id):
            # The start was not seen (or carried no child session id).
            _run_hook(None, _payload("SubagentStop", parent_session_id,
                                     agent_type=child_role or "subagent", status=child_status))
    except Exception:
        pass


def register(ctx):
    hooks = (
        ("on_session_start", _on_session_start),
        ("on_session_open", _on_session_open),
        ("post_compaction", _post_compaction),
        ("pre_llm_call", _pre_llm_call),
        ("pre_tool_call", _pre_tool_call),
        ("post_tool_call", _post_tool_call),
        ("subagent_start", _subagent_start),
        ("subagent_stop", _subagent_stop),
    )
    for name, callback in hooks:
        try:
            ctx.register_hook(name, callback)
        except Exception:
            pass  # a Hermes version without this hook
    try:
        register_section = getattr(ctx, "register_system_prompt_section", None)
        if callable(register_section):
            register_section(_SECTION_ID, _system_prompt_section,
                             position="after_memory", max_chars=_SECTION_MAX_CHARS)
    except Exception:
        pass
