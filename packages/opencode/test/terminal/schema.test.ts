import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Info, Log } from "../../src/terminal/schema"
import path from "node:path"

test("the desktop and backend consume the same terminal record fixture", async () => {
  const fixture = await Bun.file(path.resolve(import.meta.dir, "../../../../../config/contracts/terminal-record.json")).json()
  const info = Schema.decodeUnknownSync(Info)(fixture)
  expect(info).toMatchObject({ ownerID: "fixture-owner", backendPID: 23456, status: "completed", cursor: 7 })
  expect(() => Schema.decodeUnknownSync(Info)({ ...fixture, status: "unknown" })).toThrow()
  expect(() => Schema.decodeUnknownSync(Info)({ ...fixture, cursor: -1 })).toThrow()
})

test("terminal log contracts reject malformed cursor and status fields", () => {
  const log = { data: "Zml4dHVyZQ==", start: 0, cursor: 7, baseCursor: 0, endCursor: 7, truncated: false, status: "completed" as const }
  expect(Schema.decodeUnknownSync(Log)(log)).toEqual(log)
  expect(() => Schema.decodeUnknownSync(Log)({ ...log, cursor: 0.5 })).toThrow()
  expect(() => Schema.decodeUnknownSync(Log)({ ...log, status: "unknown" })).toThrow()
})
