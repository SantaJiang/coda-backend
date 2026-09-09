export * as ServerAuth from "./auth"

import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted } from "effect"

export type Credentials = {
  password?: string
  username?: string
}

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
}

// Accepts the upstream OPENCODE_SERVER_* names and the Coda CODA_SERVER_*
// names. The upstream name wins when both are set so this stays in agreement
// with Flag, which uses the same precedence.
function serverEnv(primaryName: string, fallbackName: string) {
  return EffectConfig.string(primaryName).pipe(EffectConfig.orElse(() => EffectConfig.string(fallbackName)))
}

function serverEnvValue(primaryName: string, fallbackName: string) {
  return process.env[primaryName] || process.env[fallbackName]
}

export class Config extends Context.Service<Config, Info>()("@opencode/ServerAuthConfig") {
  static configLayer(input: Info) {
    return Layer.succeed(this, this.of(input))
  }

  static get layer() {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        return Config.of(
          yield* EffectConfig.all({
            password: serverEnv("OPENCODE_SERVER_PASSWORD", "CODA_SERVER_PASSWORD").pipe(EffectConfig.option),
            username: serverEnv("OPENCODE_SERVER_USERNAME", "CODA_SERVER_USERNAME").pipe(
              EffectConfig.withDefault("coda"),
            ),
          }),
        )
      }),
    )
  }
}

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

export function authorized(credentials: DecodedCredentials, config: Info) {
  return (
    Option.isSome(config.password) &&
    credentials.username === config.username &&
    Redacted.value(credentials.password) === config.password.value
  )
}

export function header(credentials?: Credentials) {
  const password = credentials?.password ?? serverEnvValue("OPENCODE_SERVER_PASSWORD", "CODA_SERVER_PASSWORD")
  if (!password) return undefined

  const username =
    credentials?.username ?? serverEnvValue("OPENCODE_SERVER_USERNAME", "CODA_SERVER_USERNAME") ?? "coda"
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
}

export function headers(credentials?: Credentials) {
  const authorization = header(credentials)
  if (!authorization) return undefined
  return { Authorization: authorization }
}
