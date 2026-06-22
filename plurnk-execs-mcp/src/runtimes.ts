import type { RuntimeDecl } from "@plurnk/plurnk-execs";
import { serverNames } from "./config.ts";

const GLYPH = "🔌";

// The dynamic runtimes hook (plurnk-execs#10), pointed at by this package's
// `plurnk.runtimesModule`. The framework's `discover()` imports and calls it at
// scan time — but only for a trusted package — to materialize the per-deployment
// tags a static `plurnk.runtimes[]` can't express.
//
// Each MCP server an operator declares as `PLURNK_MCP_<server>=<target>` becomes
// one EXEC tag named for the server (the model-alias convention); its tools are
// called from the EXEC body. Reads the environment ONLY — no network — so
// discovery stays cheap and offline; reachability and the live tool catalog are
// probe()/run()'s job at boot/call.
export function runtimes(): RuntimeDecl[] {
    return serverNames().map((name) => ({
        name,
        glyph: GLYPH,
        // The discovery move — concrete, valid, and server-agnostic (the tools
        // are per-deployment, so no real tool name is universally correct; `?`
        // lists them). The full canonical op, `<<`-delimited, surfaced verbatim.
        example: `<<EXEC[${name}]:?:EXEC`,
        documentation: doc(name),
    }));
}

// Per-tag documentation served on demand. Static usage — the *live* tool
// catalog is fetched by running the tag with an empty (or `?`) body, since
// listing tools requires a connection we deliberately don't open at scan time.
const doc = (name: string): string => `# ${name} (MCP)

An MCP server bridged as an EXEC tag. Its output lands behind \`${name}://\` and
is READ back slice-wise — never dumped inline.

## Calling a tool

\`\`\`
<<EXEC[${name}]:<tool_name> <json-arguments>:EXEC
\`\`\`

\`<json-arguments>\` is a single JSON object (omit it for a no-argument tool):

\`\`\`
<<EXEC[${name}]:create_issue {"title":"Bug","body":"…"}:EXEC
<<EXEC[${name}]:list_repos:EXEC
\`\`\`

## Discovering tools

Run the tag with \`?\` (or \`help\`, or an empty body) to write the server's live
tool catalog — names, descriptions, and input JSON schemas — to the results
stream:

\`\`\`
<<EXEC[${name}]:?:EXEC
\`\`\`

## Output & gating

The tool result is JSON on the \`results\` channel. Every call is proposal-gated
(treated as host-effecting) — the side-effect class of an individual MCP tool
isn't known at gate time, so the conservative default applies.
`;
