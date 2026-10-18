import { Schema } from "effect"

export const Status = Schema.Literals(["starting", "running", "completed", "failed", "cancelled", "interrupted"])
const Cursor = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
export const Info = Schema.Struct({
  id: Schema.String, sessionID: Schema.String, rootSessionID: Schema.String,
  command: Schema.String, cwd: Schema.String, startedAt: Schema.Number, lastOutputAt: Schema.Number,
  status: Status, cursor: Cursor, baseCursor: Cursor,
  directory: Schema.optional(Schema.String), ownerID: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Number), backendPID: Schema.optional(Schema.Number),
  messageID: Schema.optional(Schema.String), turnID: Schema.optional(Schema.String),
  rootTurnID: Schema.optional(Schema.String), callID: Schema.optional(Schema.String), shell: Schema.optional(Schema.String),
  endedAt: Schema.optional(Schema.Number), exitCode: Schema.optional(Schema.Number), reason: Schema.optional(Schema.String),
  recoverable: Schema.optional(Schema.Boolean), needsInput: Schema.optional(Schema.Boolean),
  consumed: Schema.optional(Schema.Boolean), suppressed: Schema.optional(Schema.Boolean), hidden: Schema.optional(Schema.Boolean),
  nextCheckAt: Schema.optional(Schema.Number), error: Schema.optional(Schema.String),
  segments: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, start: Cursor, size: Cursor }))),
})
export const Log = Schema.Struct({
  data: Schema.String, start: Cursor, cursor: Cursor, baseCursor: Cursor, endCursor: Cursor,
  truncated: Schema.Boolean, status: Status, ended: Schema.optional(Schema.Boolean),
})
export const List = Schema.Struct({ backendID: Schema.String, items: Schema.Array(Info) })
