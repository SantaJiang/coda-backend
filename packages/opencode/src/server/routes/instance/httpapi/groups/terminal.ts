import { Info, Log, List } from "@/terminal/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { SessionID } from "@/session/schema"

const query = Schema.Struct({ ...WorkspaceRoutingQueryFields })
const params = { sessionID: SessionID, terminalID: Schema.String }
export const TerminalApi = HttpApi.make("coda-terminal").add(
  HttpApiGroup.make("terminal")
    .add(
      HttpApiEndpoint.get("list", "/session/:sessionID/terminals", {
        params: { sessionID: SessionID },
        query,
        error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        success: List,
      }),
      HttpApiEndpoint.get("logs", "/session/:sessionID/terminals/:terminalID/log", {
        params,
        query: Schema.Struct({
          ...WorkspaceRoutingQueryFields,
          cursor: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
          limit: Schema.optional(
            Schema.NumberFromString.check(
              Schema.isInt(),
              Schema.isGreaterThanOrEqualTo(1),
              Schema.isLessThanOrEqualTo(262144),
            ),
          ),
        }),
        error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        success: Log,
      }),
      HttpApiEndpoint.get("stream", "/session/:sessionID/terminals/:terminalID/stream", {
        params,
        query: Schema.Struct({
          ...WorkspaceRoutingQueryFields,
          cursor: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
        }),
        error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
      }),
      HttpApiEndpoint.post("control", "/session/:sessionID/terminals/:terminalID/control", {
        params,
        query,
        payload: Schema.Struct({ action: Schema.Literals(["cancel", "hide", "show", "resume"]) }),
        error: [HttpApiError.BadRequest, HttpApiError.NotFound],
        success: Schema.Union([Schema.Boolean, Info]),
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
