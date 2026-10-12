"""Vault-local OpenCode plugin around the single installed lifecycle adapter."""
import json
import os
import sys

WRITE_TOOLS = ('edit', 'write', 'patch', 'apply_patch', 'multiedit')

PLUGIN = r'''// Beyin V3 OpenCode plugin; installer-owned, removed by rollback and uninstall.
import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"

const PYTHON = process.env.BEYIN_PYTHON || __PYTHON__
const VAULT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const HOOK = join(VAULT, ".claude", "scripts", "beyin_v3_hook.py")
const WRITE_TOOLS = new Set(__WRITE_TOOLS__)

function runtimeState() {
  try {
    const data = JSON.parse(readFileSync(join(VAULT, ".beyin-runtime.json"), "utf8"))
    return typeof data?.state === "string" && isAbsolute(data.state) ? data.state : null
  } catch {
    return null
  }
}

function runHook(state, payload) {
  // Fail open: any transport failure means no context, never a broken OpenCode turn.
  return new Promise((resolve) => {
    try {
      const child = execFile(PYTHON, [HOOK, "--vault", VAULT, "--state", state, "--harness", "opencode"],
        { timeout: __TIMEOUT__, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" } },
        (error, stdout) => {
          try {
            const text = error ? "" : JSON.parse(String(stdout || "{}"))?.hookSpecificOutput?.additionalContext
            resolve(typeof text === "string" ? text : "")
          } catch {
            resolve("")
          }
        })
      child.on("error", () => resolve(""))
      child.stdin.on("error", () => {})
      child.stdin.end(JSON.stringify(payload))
    } catch {
      resolve("")
    }
  })
}

// One session tracker behind both plugin APIs, so 1.x and 2.x queue identical events.
function lifecycle(state, parentOf) {
  const sessions = new Map()
  const send = (event, id, prompt) => runHook(state, { hook_event_name: event, session_id: id, ...(prompt === undefined ? {} : { prompt }) })
  const tracked = (id) => {
    const info = typeof id === "string" && id ? sessions.get(id) : undefined
    return info && !info.child ? info : undefined
  }

  async function open(id) {
    if (!sessions.has(id)) {
      let child = false
      try {
        child = Boolean(await parentOf(id))
      } catch {}
      // Sub-agent sessions never submit receipts; tracking them would report false gaps.
      sessions.set(id, { child, start: null, turn: "", turnID: "", turns: new Map(), attached: new Set() })
    }
    return sessions.get(id)
  }

  return {
    sessions,
    tracked,
    async message(id, prompt, messageID) {
      if (typeof id !== "string" || !id) return
      const info = await open(id)
      if (info.child) return
      if (info.start === null) info.start = await send("SessionStart", id, prompt())
      else {
        info.turn = await send("UserPromptSubmit", id, prompt())
        info.turnID = typeof messageID === "string" ? messageID : ""
        if (info.turn && info.turnID) info.turns.set(info.turnID, info.turn)
      }
      return info
    },
    // SessionStart context stays for the whole session, the latest prompt context for its turn.
    context(id) {
      const info = tracked(id)
      if (!info) return []
      // Once the latest turn's context rides in its own user message, the system prompt holds
      // only the session context: it stays byte-identical, so the provider's prompt cache keeps
      // the whole conversation after it. A turn that could not be attached (a release that
      // sends no message id) keeps its context here instead of losing it.
      const inMessage = info.turnID && info.attached.has(info.turnID)
      return [info.start, inMessage ? "" : info.turn].filter((text) => text)
    },
    // Each prompt's context, attached to that prompt's message in every request of the session.
    attach(messages) {
      for (const entry of Array.isArray(messages) ? messages : []) {
        const message = entry?.info
        const info = message?.role === "user" ? tracked(message.sessionID) : undefined
        if (!info || !Array.isArray(entry.parts)) continue
        const text = info.turns.get(message.id)
        if (!text) continue
        const id = `${message.id}-beyin-v3`
        if (!entry.parts.some((part) => part?.id === id))
          entry.parts.push({ id, sessionID: message.sessionID, messageID: message.id, type: "text", text, synthetic: true })
        info.attached.add(message.id)
      }
    },
    // OpenCode 2.x hands each request's messages as { id, role, content: [{ type, text }] },
    // rebuilt for every request, so the turn context is attached again each time.
    attachModel(id, messages) {
      const info = tracked(id)
      if (!info) return
      for (const message of Array.isArray(messages) ? messages : []) {
        if (message?.role !== "user" || !Array.isArray(message.content)) continue
        const text = info.turns.get(message.id)
        if (!text) continue
        if (!message.content.some((part) => part?.type === "text" && part.text === text))
          message.content.push({ type: "text", text })
        info.attached.add(message.id)
      }
    },
    async tool(id, tool) {
      if (tracked(id) && WRITE_TOOLS.has(tool)) await send("PostToolUse", id)
    },
    async compact(id) {
      if (tracked(id)) await send("PreCompact", id)
    },
    async stop(id) {
      if (tracked(id)) await send("Stop", id)
    },
    async end(id) {
      const info = tracked(id)
      if (info && !info.ended) {
        info.ended = true
        await send("SessionEnd", id)
      }
      sessions.delete(id)
    },
  }
}

// OpenCode 1.x: a factory returning named hooks.
export const BeyinV3 = async ({ client } = {}) => {
  const state = runtimeState()
  if (!state) return {}
  const core = lifecycle(state, async (id) => (await client?.session?.get?.({ path: { id } }))?.data?.parentID)

  return {
    "chat.message": async (input, output) => {
      await core.message(input?.sessionID, () => (output?.parts || [])
        .filter((part) => part?.type === "text" && !part.synthetic && typeof part.text === "string")
        .map((part) => part.text).join("\n"), output?.message?.id ?? input?.messageID)
    },
    // Runs before the system transform of the same request; a release without it keeps the
    // turn context in the system prompt instead.
    "experimental.chat.messages.transform": async (_input, output) => {
      core.attach(output?.messages)
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (Array.isArray(output?.system)) output.system.push(...core.context(input?.sessionID))
    },
    "tool.execute.after": async (input) => {
      await core.tool(input?.sessionID, input?.tool)
    },
    "experimental.session.compacting": async (input) => {
      await core.compact(input?.sessionID)
    },
    event: async ({ event } = {}) => {
      if (event?.type === "session.idle") await core.stop(event.properties?.sessionID)
      else if (event?.type === "session.deleted") await core.end(event.properties?.info?.id)
    },
  }
}

// OpenCode 2.0 ends a turn with an execution event and no longer emits session.idle;
// idle stays accepted so a release that brings it back cannot double Stop.
const TURN_END = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.idle"])

// OpenCode 2.x: setup(ctx) registers hooks on the context and returns a cleanup.
async function setup(ctx) {
  const state = runtimeState()
  if (!state) return
  const core = lifecycle(state, async (id) => (await ctx?.session?.get?.({ sessionID: id }))?.parentID)
  const hook = async (register) => {
    try {
      await register()
    } catch {}
  }

  await hook(() => ctx.session.hook("prompt", async (event) => {
    const info = await core.message(event?.sessionID, () => (typeof event?.prompt?.text === "string" ? event.prompt.text : ""),
      event?.messageID)
    if (info) info.awaitingStop = true
  }))
  // One hook carries both: the turn context goes to its own message first, so the system part
  // holds only the session context and stays identical for the provider's prompt cache.
  await hook(() => ctx.session.hook("context", async (event) => {
    core.attachModel(event?.sessionID, event?.messages)
    if (Array.isArray(event?.system))
      for (const text of core.context(event?.sessionID)) event.system.push({ type: "text", text })
  }))
  await hook(() => ctx.tool.hook("execute.after", async (event) => {
    if (event?.status !== "error") await core.tool(event?.sessionID, event?.tool)
  }))
  await hook(() => ctx.session.hook("compaction", async (event) => {
    await core.compact(event?.sessionID)
  }))

  const controller = new AbortController()
  ;(async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const id = event?.data?.sessionID
        const info = core.tracked(id)
        // One Stop per prompted turn, whichever end event arrives.
        if (TURN_END.has(event?.type) && info?.awaitingStop) {
          info.awaitingStop = false
          await core.stop(id)
        } else if (event?.type === "session.deleted") await core.end(id)
      }
    } catch {}
  })()

  // Plugins live in the background service, which outlives any client, so SessionEnd
  // comes from session.deleted or from this cleanup when the service stops or reloads.
  return async () => {
    controller.abort()
    await Promise.all([...core.sessions.keys()].map((id) => core.end(id)))
  }
}

// 2.x reads { id, setup }; 1.x (1.3.4+) reads { id, server } and ignores setup.
export default { id: "beyin-v3", server: BeyinV3, setup }
'''


def plan_plugin(vault, state):
    """Return plugin bytes; vault comes from the file location and state from .beyin-runtime.json."""
    if any(char in sys.executable for char in '\r\n\x00'):
        raise ValueError('Unsupported interpreter path')
    source = (PLUGIN.replace('__PYTHON__', json.dumps(sys.executable))
              .replace('__TIMEOUT__', '20000' if os.name == 'nt' else '6000')
              .replace('__WRITE_TOOLS__', json.dumps(list(WRITE_TOOLS))))
    return {'.opencode/plugins/beyin-v3.js': source.encode('utf-8')}
