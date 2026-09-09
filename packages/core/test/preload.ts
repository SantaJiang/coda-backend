import path from "path"

process.env.OPENCODE_DB = ":memory:"
process.env.NPM_CONFIG_AUDIT = "false"
process.env.OPENCODE_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"

// Clear ambient config and server auth overrides. Flag resolves these at import
// time, preferring the OPENCODE_* names and falling back to CODA_*, so a value
// left in a developer's shell would leak into tests.
delete process.env.OPENCODE_CONFIG
delete process.env.OPENCODE_CONFIG_DIR
delete process.env.OPENCODE_CONFIG_CONTENT
delete process.env.CODA_CONFIG
delete process.env.CODA_CONFIG_DIR
delete process.env.CODA_CONFIG_CONTENT
delete process.env.OPENCODE_SERVER_PASSWORD
delete process.env.OPENCODE_SERVER_USERNAME
delete process.env.CODA_SERVER_PASSWORD
delete process.env.CODA_SERVER_USERNAME
