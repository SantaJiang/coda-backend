import { Effect } from "effect"
import { Session } from "../session/session"
import { SessionPrompt } from "../session/prompt"
import { SessionStatus } from "../session/status"
import { SessionID, PartID } from "../session/schema"
import * as Store from "./store"
import * as Client from "./client"
import { result } from "./tools"
import fs from "node:fs"

export function eligible(info: Store.Info & Store.Control, ownerID: string) {
  const checkpoint = Store.run(info.sessionID)
  return (
    info.ownerID === ownerID &&
    !info.suppressed &&
    !checkpoint?.suppressed &&
    ((info.status === "interrupted" && !info.consumed) ||
      Boolean(checkpoint?.active && checkpoint.backendID !== Client.backendID && checkpoint.turnID === info.turnID))
  )
}

const recovering = new Set<string>()
export function resume(
  info: Store.Info,
  sessions: Session.Interface,
  prompt: SessionPrompt.Interface,
  status: SessionStatus.Interface,
) {
  return Effect.gen(function* () {
    const key = info.sessionID
    if (recovering.has(key)) return
    const currentStatus = (yield* status.list()).get(SessionID.make(key))
    if (currentStatus && currentStatus.type !== "idle") return
    recovering.add(key)
    try {
      Store.owner()
      if (!fs.existsSync(info.directory)) throw new Error("项目目录不存在，请恢复目录后继续任务")
      const current = Store.control(info.id)
      const checkpoint = Store.run(key)
      if (current.suppressed || checkpoint?.suppressed || (current.consumed && !checkpoint?.active)) return
      const messages = yield* sessions.messages({ sessionID: SessionID.make(key) }).pipe(Effect.orDie)
      const user = messages.findLast((message) => message.info.role === "user")
      if (!user || user.info.id !== info.turnID || info.ownerID !== Store.owner().id) {
        Store.update(info.id, { suppressed: true })
        return
      }
      const tasks = Store.list(info.directory, key).filter(
        (task) => task.sessionID === key && task.turnID === info.turnID && !task.suppressed,
      )
      for (const task of tasks) {
        const next = yield* Effect.promise(() => Client.refresh(task.id))
        const value = result(next)
        for (const message of messages)
          for (const part of message.parts) {
            if (part.type !== "tool") continue
            const terminalID = "metadata" in part.state ? part.state.metadata?.terminalID : undefined
            if (terminalID !== task.id && !(message.info.id === task.messageID && part.callID === task.callID)) continue
            yield* sessions.updatePart({
              ...part,
              state: {
                status: "completed",
                input: part.state.input,
                title: value.title,
                metadata: value.metadata,
                output: value.output,
                time: { start: task.startedAt, end: Date.now() },
              },
            })
          }
      }
      const assistant = messages.findLast((message) => message.info.role === "assistant")
      if (assistant?.info.role === "assistant")
        yield* sessions.updateMessage({
          ...assistant.info,
          finish: "tool-calls",
          error: undefined,
          time: { ...assistant.info.time, completed: Date.now() },
        })
      Store.update(info.id, { error: undefined })
      if (checkpoint?.active) {
        const latestUser = messages.findLast((message) => message.info.role === "user")
        if (latestUser)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            type: "text",
            synthetic: true,
            text: "[Coda recovery] The backend was interrupted. First inspect the project and existing command results. Do not replay an earlier command automatically.",
            sessionID: latestUser.info.sessionID,
            messageID: latestUser.info.id,
          })
      }
      if (Store.control(info.id).suppressed || Store.run(key)?.suppressed) return
      yield* prompt.loop({ sessionID: SessionID.make(key) })
      for (const task of tasks) Store.update(task.id, { consumed: true })
    } finally {
      recovering.delete(key)
    }
  })
}
