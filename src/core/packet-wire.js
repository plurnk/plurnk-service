// Packet → wire markdown projection. Single source of truth for how the
// spec'd Packet.json (system/user sections) renders to ChatMessage.content
// strings the LLM receives. Engine imports this for the wire payload; the
// digest tool imports it to write byte-identical packetNNN.{system,user}.md
// files. No second implementation, no drift.
//
// Format: markdown. user picked it over rummy's XML and JSON alternatives
// 2026-05-22. Standard markdown idioms only — headers as section delimiters,
// fenced code blocks for entry bodies, lists for arrays. No invented
// separators. Models parse markdown natively.

// Render packet.system → system message content (markdown string).
// Layout:
//   {system_definition verbatim — already a markdown doc with its own headers}
//
//   # Persona            (only if non-empty)
//   {persona text}
//
//   # Index              (only if entries present)
//   ## known://path/one
//   - mimetype: ..., tokens: ...
//   ```
//   <body>
//   ```
//   ## known://path/two
//   ...
//
//   # Log                (only if entries present)
//   ## [loop/turn/action] OP target → status
//   ```
//   <rx>
//   ```
export const renderSystemContent = (system) => {
    const parts = [system.system_definition];
    if (typeof system.persona === "string" && system.persona.length > 0) {
        parts.push(`# Plurnk System Instructions\n\n${system.persona}`);
    }
    if (Array.isArray(system.index) && system.index.length > 0) {
        parts.push(`# Index\n\n${renderIndexEntries(system.index)}`);
    }
    if (Array.isArray(system.log) && system.log.length > 0) {
        parts.push(`# Log\n\n${renderLogEntries(system.log)}`);
    }
    return parts.join("\n\n");
};

// Render packet.user → user message content (markdown string).
// Layout:
//   {prompt verbatim — the user's actual ask}
//
//   # System Requirements  (per-turn rules — turn-N/M continuation lives here)
//   {system_requirements text}
//
//   # Telemetry
//   ## Budget              (only if non-empty)
//   {budget text}
//   ## Errors              (only if non-empty)
//   - <error1>
//   - <error2>
export const renderUserContent = (user) => {
    const parts = [user.prompt];
    if (typeof user.system_requirements === "string" && user.system_requirements.length > 0) {
        parts.push(`# System Requirements\n\n${user.system_requirements}`);
    }
    const telemetry = user.telemetry ?? { budget: "", errors: [] };
    const telemetryParts = [];
    if (typeof telemetry.budget === "string" && telemetry.budget.length > 0) {
        telemetryParts.push(`## Budget\n\n${telemetry.budget}`);
    }
    if (Array.isArray(telemetry.errors) && telemetry.errors.length > 0) {
        telemetryParts.push(`## Errors\n\n${renderTelemetryErrors(telemetry.errors)}`);
    }
    if (telemetryParts.length > 0) {
        parts.push(`# Telemetry\n\n${telemetryParts.join("\n\n")}`);
    }
    return parts.join("\n\n");
};

// Project the full request half of a packet to ChatMessage[] for the wire.
// Engine calls this directly; the result is what provider.generate receives.
export const packetToWireMessages = (packet) => [
    { role: "system", content: renderSystemContent(packet.system) },
    { role: "user", content: renderUserContent(packet.user) },
];

// Render one Index entry → h2 heading + metadata list + body fence.
// Input shape comes from Engine.#buildIndex (Entry.json projection):
//   { id, scheme, pathname, channels: { body: { content, mimetype, tokens } }, ... }
const renderIndexEntries = (entries) =>
    entries.map((e) => {
        const scheme = e.scheme ?? "?";
        const path = e.pathname ?? "";
        const uri = `${scheme}://${path}`;
        const body = e.channels?.body ?? null;
        const meta = [];
        if (body !== null) {
            meta.push(`mimetype: ${body.mimetype ?? "text/markdown"}`);
            if (typeof body.tokens === "number") meta.push(`tokens: ${body.tokens}`);
        }
        const metaBlock = meta.length > 0 ? `- ${meta.join(", ")}\n\n` : "";
        const bodyContent = body?.content ?? "";
        return `## ${uri}\n\n${metaBlock}\`\`\`\n${bodyContent}\n\`\`\``;
    }).join("\n\n");

// Render one Log entry → h2 heading + rx body fence.
// Input shape comes from Engine.#buildLog (LogEntry.json projection).
const renderLogEntries = (entries) =>
    entries.map((e) => {
        const coordinate = e.coordinate ?? "?";
        const op = e.op ?? "?";
        const target = renderLogTarget(e.target);
        const status = e.status ?? "?";
        const rxBody = typeof e.rx === "string" ? e.rx : JSON.stringify(e.rx);
        return `## [${coordinate}] ${op} ${target} → ${status}\n\n\`\`\`\n${rxBody}\n\`\`\``;
    }).join("\n\n");

const renderLogTarget = (target) => {
    if (target === null || target === undefined) return "—";
    const scheme = target.scheme;
    const pathname = target.pathname ?? "";
    if (scheme !== null && scheme !== undefined) return `${scheme}://${pathname}`;
    return pathname.length > 0 ? pathname : "—";
};

// Render TelemetryError[] → bullet list. v0 schema is open per Packet.json
// ("Inner shapes intentionally open at v0; consumers populate as needs
// solidify"), so this just emits each error as a JSON line until the
// shape settles.
const renderTelemetryErrors = (errors) =>
    errors.map((e) => `- ${JSON.stringify(e)}`).join("\n");
