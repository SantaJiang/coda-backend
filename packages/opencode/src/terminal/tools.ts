import path from "node:path"
import { Effect, Schema } from "effect"
import { Tool } from "../tool/tool"
import { InstanceState } from "../effect/instance-state"
import * as Client from "./client"
import * as Store from "./store"

export function result(info: Store.Info, cursor?: number) {
  const output = Store.log(info, cursor, 24 * 1024)
  const text = Buffer.from(output.data, "base64").toString("utf8")
  const running = Store.active(info)
  const needsInput = Store.control(info.id).needsInput === true
  const silent = Date.now() - info.lastOutputAt > 300_000
  return {
    title: info.command,
    metadata: { terminalID: info.id, terminalStatus: info.status, exit: info.exitCode, cursor: output.cursor },
    output: JSON.stringify({
      task_id: info.id,
      status: info.status,
      exit_code: info.exitCode,
      cursor: output.cursor,
      output: text || "(no new output)",
      truncated: output.truncated,
      has_more_output: output.cursor < output.endCursor,
      reason: info.reason,
      needs_input: needsInput,
      silent_for_five_minutes: silent,
      instruction:
        needsInput && running
          ? "The command appears to require interactive input. This terminal is read-only: explain the blocker to the user, cancel or replace the command with an authorized non-interactive operation. Do not keep waiting blindly."
          : running
            ? "Command is still running. Use shell_wait with this task_id and cursor; wait_ms normally 30000, or 60000 if unchanged (maximum 120000). Do not rerun the command. Inspect authentication or interactive prompts; never invent a completion ETA."
            : "Command has ended. Inspect its exit status before continuing.",
    }),
  }
}

export function execute(
  input: {
    shell: string
    command: string
    cwd: string
    directory: string
    env: NodeJS.ProcessEnv
    timeout?: number
    wait_ms?: number
  },
  ctx: Tool.Context,
) {
  return Effect.gen(function* () {
    const info = yield* Effect.promise(() =>
      Client.start({
        ...input,
        rootSessionID: String(ctx.extra?.rootSessionID ?? ctx.sessionID),
        rootTurnID: typeof ctx.extra?.rootTurnID === "string" ? ctx.extra.rootTurnID : undefined,
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        turnID: ctx.messages.findLast((item) => item.info.role === "user")?.info.id ?? ctx.messageID,
        callID: ctx.callID ?? ctx.messageID,
      }),
    )
    const waitMs = Math.max(1, Math.min(120_000, input.wait_ms ?? 10_000))
    yield* ctx.metadata({
      metadata: { terminalID: info.id, terminalStartedAt: info.startedAt, nextCheckAt: Date.now() + waitMs },
    })
    const next = yield* Effect.promise(() => Client.wait(info.id, waitMs, ctx.abort))
    return result(next)
  })
}

const params = {
  task_id: Schema.String,
  cursor: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
}
const WaitParameters = Schema.Struct({
  ...params,
  wait_ms: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(120_000)),
  ),
})

function define(name: "shell_wait" | "shell_status" | "shell_cancel") {
  return Tool.define(
    name,
    Effect.succeed({
      description:
        name === "shell_wait"
          ? "Wait for an existing shell command, returning immediately on completion. Time is the next check interval, not a command timeout or completion ETA. Pass the previous cursor to receive only new output. Default 30 seconds; use 60 seconds when unchanged, maximum 120 seconds."
          : name === "shell_cancel"
            ? "Stop an existing shell command and its process tree."
            : "Read an existing shell command's status and new output without waiting.",
      parameters: WaitParameters,
      execute: (input: typeof WaitParameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const directory = path.resolve((yield* InstanceState.context).directory)
          const info = yield* Effect.promise(() => Client.refresh(input.task_id))
          if (info.directory !== directory || info.sessionID !== ctx.sessionID)
            throw new Error("Terminal does not belong to this session")
          if (name === "shell_cancel") return result(yield* Effect.promise(() => Client.cancel(info.id)), input.cursor)
          const ms = name === "shell_wait" ? (input.wait_ms ?? 30_000) : 0
          yield* ctx.metadata({
            metadata: { terminalID: info.id, terminalStartedAt: info.startedAt, nextCheckAt: Date.now() + ms },
          })
          return result(yield* Effect.promise(() => Client.wait(info.id, ms, ctx.abort)), input.cursor)
        }),
    }),
  )
}
export const Wait = define("shell_wait")
export const Status = define("shell_status")
export const Cancel = define("shell_cancel")
