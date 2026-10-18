import { expect, test } from "bun:test"

test("Coda environment names take precedence while legacy names remain accepted", async () => {
  const script = `const { Flag } = await import("./src/flag/flag.ts"); console.log(JSON.stringify({ client: Flag.OPENCODE_CLIENT, db: Flag.OPENCODE_DB, disabled: Flag.OPENCODE_DISABLE_AUTOUPDATE, config: Flag.OPENCODE_CONFIG }))`
  const run = async (env: Record<string, string>) => {
    const child = Bun.spawn([process.execPath, "-e", script], { cwd: import.meta.dir + "/..", env: { PATH: process.env.PATH, ...env }, stdout: "pipe", stderr: "pipe" })
    const text = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    return JSON.parse(text)
  }
  expect(await run({ CODA_CLIENT: "coda", OPENCODE_CLIENT: "legacy", CODA_DB: ":memory:", OPENCODE_DB: "legacy.db", CODA_DISABLE_AUTOUPDATE: "true", CODA_CONFIG: "coda.json", OPENCODE_CONFIG: "legacy.json" })).toEqual({ client: "coda", db: ":memory:", disabled: true, config: "coda.json" })
  expect(await run({ OPENCODE_CLIENT: "legacy", OPENCODE_DB: "legacy.db", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_CONFIG: "legacy.json" })).toEqual({ client: "legacy", db: "legacy.db", disabled: true, config: "legacy.json" })
})
