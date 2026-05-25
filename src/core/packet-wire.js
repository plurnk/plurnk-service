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

// Section headers follow the `# Plurnk System X` convention so the model
// sees consistent framing across every section it might receive. Sections
// with no content are omitted entirely (no empty headers in the wire).

// Render packet.system → system message content (markdown string).
//   {system_definition verbatim}
//   # Plurnk System Instructions   (persona)
//   # Plurnk System Index          (entries — only when present)
//   # Plurnk System Log            (log entries — only when present)
export const renderSystemContent = (system) => {
    const parts = [system.system_definition];
    if (typeof system.persona === "string" && system.persona.length > 0) {
        parts.push(`# Plurnk System Instructions\n\n${system.persona}`);
    }
    if (Array.isArray(system.index) && system.index.length > 0) {
        parts.push(`# Plurnk System Index\n\n${renderIndexEntries(system.index)}`);
    }
    if (Array.isArray(system.log) && system.log.length > 0) {
        parts.push(`# Plurnk System Log\n\n${renderLogEntries(system.log)}`);
    }
    return parts.join("\n\n");
};

// Render packet.user → user message content (markdown string).
//   # Plurnk System User Prompt
//   # Plurnk System Budget         (token budget table — only when present)
//   # Plurnk System Errors         (telemetry errors — only when present)
//   # Plurnk System Requirements   (per-turn rules incl. Turn N/M marker)
export const renderUserContent = (user) => {
    const parts = [];
    parts.push(`# Plurnk System User Prompt\n\n${user.prompt}`);
    const telemetry = user.telemetry ?? { budget: "", errors: [] };
    if (typeof telemetry.budget === "string" && telemetry.budget.length > 0) {
        parts.push(`# Plurnk System Budget\n\n${telemetry.budget}`);
    }
    if (Array.isArray(telemetry.errors) && telemetry.errors.length > 0) {
        parts.push(`# Plurnk System Errors\n\n${renderTelemetryErrors(telemetry.errors)}`);
    }
    if (typeof user.system_requirements === "string" && user.system_requirements.length > 0) {
        parts.push(`# Plurnk System Requirements\n\n${user.system_requirements}`);
    }
    return parts.join("\n\n");
};

// Project the full request half of a packet to ChatMessage[] for the wire.
// Engine calls this directly; the result is what provider.generate receives.
export const packetToWireMessages = (packet) => [
    { role: "system", content: renderSystemContent(packet.system) },
    { role: "user", content: renderUserContent(packet.user) },
];

// Number each line of body as `<N>:\t<line>` — mirrors rummy
// plugins/helpers.js numberLines. The leading digit prevents column-zero
// fence collisions and gives the model line refs for free (`READ<42-46>`).
const numberLines = (body, start = 1) => {
    if (!body) return "";
    const trailingNewline = body.endsWith("\n");
    const source = trailingNewline ? body.slice(0, -1) : body;
    const numbered = source.split("\n").map((line, i) => `${start + i}:\t${line}`).join("\n");
    return trailingNewline ? `${numbered}\n` : numbered;
};

// Stable JSON: keys sorted alphabetically so the same meta produces the
// same string across turns — prefix-cache friendly. Mirrors rummy
// plugins/helpers.js canonicalJson.
const canonicalJson = (obj) => {
    const keys = Object.keys(obj).sort();
    const sorted = {};
    for (const k of keys) sorted[k] = obj[k];
    return JSON.stringify(sorted);
};

// Heredoc block for one channel of one entry. Fence is `URI#channel`
// (plurnk-grammar-native form) so model emissions and entry projections
// share one syntax. When `channel` is null/empty the fence is path-only —
// this is the default-channel convention: the absence of `#channel` is
// the addressing of the scheme's default channel, not a missing field.
// Body is line-numbered.
const renderHeredoc = (uri, channel, body) => {
    const fence = channel ? `${uri}#${channel}` : uri;
    const numbered = numberLines(body);
    return `<<${fence}:\n${numbered}\n:${fence}`;
};

// Render one Index entry → `* {meta}` line followed by per-channel
// heredoc blocks. meta describes the entry; nested `channels` carries
// per-channel mimetype/tokens so the model doesn't have to READ to
// learn the shape of a channel's content.
const renderIndexEntries = (entries) =>
    entries.map((e) => {
        const scheme = e.scheme ?? "?";
        const path = e.pathname ?? "";
        const uri = `${scheme}://${path}`;
        const defaultChannel = e.defaultChannel ?? "";
        const meta = { path: uri };
        if (Array.isArray(e.tags) && e.tags.length > 0) meta.tags = e.tags;
        const channelsMeta = {};
        const blocks = [];
        for (const [channelName, ch] of Object.entries(e.channels ?? {})) {
            const content = ch?.content;
            if (typeof content !== "string") continue;
            const channelInfo = {};
            if (typeof ch.mimetype === "string") channelInfo.mimetype = ch.mimetype;
            if (typeof ch.tokens === "number") channelInfo.tokens = ch.tokens;
            channelsMeta[channelName] = channelInfo;
            const fenceChannel = channelName === defaultChannel ? null : channelName;
            blocks.push(renderHeredoc(uri, fenceChannel, content));
        }
        if (Object.keys(channelsMeta).length > 0) meta.channels = channelsMeta;
        return blocks.length > 0
            ? `* ${canonicalJson(meta)}\n${blocks.join("\n")}`
            : `* ${canonicalJson(meta)}`;
    }).join("\n");

// Render one Log entry → `* {meta}` line followed by the response body.
// URI is `log://<coordinate>/<op>` per SPEC §10 — the trailing /op is
// wire-rendering self-documentation derived from the row's `op` field
// (parsing the URI accepts it or omits it; identification is by
// coordinate). Log entries are single-payload by nature — fence carries
// no `#channel` (matches the default-channel convention).
const renderLogEntries = (entries) =>
    entries.map((e) => {
        const coordinate = e.coordinate ?? "?";
        const opSuffix = typeof e.op === "string" && e.op.length > 0 ? `/${e.op}` : "";
        const uri = `log://${coordinate}${opSuffix}`;
        const meta = {};
        if (typeof e.origin === "string") meta.origin = e.origin;
        if (typeof e.op === "string") meta.op = e.op;
        if (typeof e.status === "number") meta.status = e.status;
        const target = renderLogTarget(e.target);
        if (target !== null) meta.target = target;
        const rxBody = typeof e.rx === "string" ? e.rx : JSON.stringify(e.rx);
        return `* ${canonicalJson(meta)}\n${renderHeredoc(uri, null, rxBody)}`;
    }).join("\n");

const renderLogTarget = (target) => {
    if (target === null || target === undefined) return null;
    const scheme = target.scheme;
    const pathname = target.pathname ?? "";
    if (scheme !== null && scheme !== undefined) return `${scheme}://${pathname}`;
    return pathname.length > 0 ? pathname : null;
};

// Render TelemetryError[] → bullet list. v0 schema is open per Packet.json
// ("Inner shapes intentionally open at v0; consumers populate as needs
// solidify"), so this just emits each error as a JSON line until the
// shape settles.
const renderTelemetryErrors = (errors) =>
    errors.map((e) => `* ${canonicalJson(e)}`).join("\n");
