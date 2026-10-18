import { Effect, Scope, Schedule } from "effect"
import * as Stream from "effect/Stream"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { HttpServerResponse } from "effect/unstable/http"
import { InstanceHttpApi } from "../api"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import * as Store from "@/terminal/store"
import * as Client from "@/terminal/client"
import { eligible, resume } from "@/terminal/recovery"
import { InstanceStore } from "@/project/instance-store"

export const terminalHandlers = HttpApiBuilder.group(InstanceHttpApi, "terminal", (handlers) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const status = yield* SessionStatus.Service
    const scope = yield* Scope.Scope
    const instances = yield* InstanceStore.Service
    const checked = Effect.fnUntraced(function* (params: { sessionID: SessionID; terminalID: string }) {
      const directory = (yield* InstanceState.context).directory
      yield* sessions.get(params.sessionID).pipe(Effect.mapError(() => new HttpApiError.NotFound({})))
      const info = Store.list(directory, params.sessionID).find((info) => info.id === params.terminalID)
      if (!info) return yield* Effect.fail(new HttpApiError.NotFound({}))
      return yield* Effect.promise(() => Client.refresh(info.id))
    })
    const recover = (info: Store.Info) =>
      resume(info, sessions, prompt, status).pipe(
        Effect.catchCause((cause) => Effect.sync(() => Store.update(info.id, { error: String(cause) }))),
      )
    // Recovery belongs to the backend, including sessions not currently open in
    // the WebView. Each session still shares the persisted stop guard and lock.
    yield* Effect.gen(function* () {
      if (Store.settings().taskRecovery === "manual") return
      let owner: Store.Owner
      try {
        owner = Store.owner()
      } catch {
        return
      }
      const tasks = Store.list().filter((info) => eligible(info, owner.id) && !info.error)
      for (const info of tasks)
        yield* instances.provide({ directory: info.directory }, recover(info)).pipe(
          Effect.catchCause((cause) => Effect.sync(() => Store.update(info.id, { error: String(cause) }))),
          Effect.forkIn(scope),
        )
    }).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.repeat(Schedule.spaced("5 seconds")),
      Effect.forkIn(scope),
    )
    return handlers
      .handle("list", ({ params }) =>
        Effect.gen(function* () {
          yield* sessions.get(params.sessionID).pipe(Effect.mapError(() => new HttpApiError.NotFound({})))
          const directory = (yield* InstanceState.context).directory
          const list = yield* Effect.promise(() =>
            Promise.all(Store.list(directory, params.sessionID).map((info) => Client.refresh(info.id))),
          )
          let ownerID = ""
          try {
            ownerID = Store.owner().id
          } catch {}
          const candidates = list.map((info) => ({ ...info, recoverable: eligible(info, ownerID) }))
          if (Store.settings().taskRecovery !== "manual") {
            for (const info of candidates)
              if (info.recoverable && !info.error) yield* recover(info).pipe(Effect.forkIn(scope))
          }
          return { backendID: Client.backendID, items: candidates }
        }),
      )
      .handle("logs", ({ params, query }) =>
        Effect.gen(function* () {
          const info = yield* checked(params)
          if (query.cursor !== undefined && (!Number.isSafeInteger(query.cursor) || query.cursor < 0))
            return yield* Effect.fail(new HttpApiError.BadRequest({}))
          return {
            ...Store.log(info, query.cursor, Math.max(1, Math.min(256 * 1024, query.limit ?? 64 * 1024))),
            status: info.status,
          }
        }),
      )
      .handleRaw("stream", ({ params, query }) =>
        Effect.gen(function* () {
          yield* checked(params)
          let cursor = query.cursor
          if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))
            return yield* Effect.fail(new HttpApiError.BadRequest({}))
          const sample = Effect.promise(async () => {
            const info = await Client.refresh(params.terminalID)
            const output = Store.log(info, cursor)
            cursor = output.cursor
            return { ...output, status: info.status, ended: !Store.active(info) && cursor >= info.cursor }
          })
          const stream = Stream.make(0).pipe(
            Stream.concat(Stream.tick("500 millis")),
            Stream.mapEffect(() => sample),
            Stream.takeUntil((frame) => frame.ended),
            Stream.map((frame) => `data: ${JSON.stringify(frame)}\n\n`),
            Stream.encodeText,
          )
          return HttpServerResponse.stream(stream, {
            contentType: "text/event-stream",
            headers: { "Cache-Control": "no-cache", "X-Accel-Buffering": "no" },
          })
        }),
      )
      .handle("control", ({ params, payload }) =>
        Effect.gen(function* () {
          const info = yield* checked(params)
          if (payload.action === "cancel") return yield* Effect.promise(() => Client.cancel(info.id))
          if (payload.action === "hide" || payload.action === "show") {
            if (Store.active(info)) return yield* Effect.fail(new HttpApiError.BadRequest({}))
            Store.update(info.id, { hidden: payload.action === "hide" })
            return true
          }
          yield* recover(info).pipe(Effect.forkIn(scope))
          return true
        }),
      )
  }),
)
