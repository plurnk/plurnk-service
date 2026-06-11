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
//
// Section headers follow the `# Plurnk System X` convention so the model
// sees consistent framing across every section it might receive. Sections
// with no content are omitted entirely (no empty headers in the wire).

import { MimetypeBinary } from "../content/index.ts";

// The SECTION shapes (SystemSection/UserSection) are the JSON boundary — they
// arrive both from Engine's in-memory packet AND from `turns.packet` re-parsed
// by the digest, so leaf fields are typed loose (`unknown` / small unions) and
// the runtime `typeof` narrowing below validates them (boundaries validate).
// The full Packet is Engine-only and contract-guaranteed (RequestPacket), so it
// is typed strict — no system/user defaulting.
interface ActionTarget { scheme?: string | null; pathname?: string | null }
interface StatementTx {
    op?: unknown;
    suffix?: unknown;
    signal?: unknown;
    target?: { raw?: unknown } | null;
    lineMarker?: { first?: unknown; last?: unknown } | null;
    body?: string | { raw?: unknown } | null;
}
interface RxView { content?: unknown; mimetype?: unknown; startLine?: unknown; matches?: unknown }
interface LogEntryView {
    coordinate?: unknown;
    op?: unknown;
    origin?: unknown;
    status?: unknown;
    target?: ActionTarget | null;
    tx?: StatementTx | null;
    rx?: unknown;
    folded?: boolean;
    source?: unknown;
}
interface TelemetryError { snippet?: unknown; position?: { line?: unknown }; [key: string]: unknown }
interface SystemSection {
    system_definition: string;
    persona?: unknown;
    log?: unknown;
    tokens?: number;
}
interface UserSection {
    prompt?: unknown;
    telemetry?: { budget?: unknown; errors?: unknown };
    system_requirements?: unknown;
    tokens?: number;
}
interface Packet { system: SystemSection; user: UserSection }
type CountTokens = (text: string) => number;

export default class PacketWire {
    // Render packet.system → system message content (markdown string).
    //   {system_definition verbatim}
    //   # Plurnk System Instructions   (persona)
    //   # Plurnk System Log            (log entries — only when present)
    static renderSystemContent(system: SystemSection): string {
        const parts: string[] = [system.system_definition];
        if (typeof system.persona === "string" && system.persona.length > 0) {
            parts.push(`# Plurnk System Instructions\n\n${system.persona}`);
        }
        if (Array.isArray(system.log) && system.log.length > 0) {
            parts.push(`# Plurnk System Log\n\n${PacketWire.#renderLogEntries(system.log)}`);
        }
        return parts.map((p) => p.replace(/\n+$/, "")).join("\n\n");
    }

    // Render packet.user → user message content (markdown string).
    //   # Plurnk System User Prompt
    //   # Plurnk System Budget         (token budget table — only when present)
    //   # Plurnk System Errors         (telemetry errors — only when present)
    //   # Plurnk System Requirements   (static per-turn rules — only when present)
    // Requirements renders LAST so the contract the model has to honor is the
    // most recent thing in the user message — closest to the assistant turn.
    static renderUserContent(user: UserSection): string {
        const parts: string[] = [];
        if (typeof user.prompt === "string" && user.prompt.length > 0) {
            parts.push(`# Plurnk System User Prompt\n\n${user.prompt}`);
        }
        const telemetry = user.telemetry ?? { budget: "", errors: [] };
        if (typeof telemetry.budget === "string" && telemetry.budget.length > 0) {
            parts.push(`# Plurnk System Budget\n\n${telemetry.budget}`);
        }
        if (Array.isArray(telemetry.errors) && telemetry.errors.length > 0) {
            parts.push(`# Plurnk System Errors\n\n${PacketWire.#renderTelemetryErrors(telemetry.errors)}`);
        }
        if (typeof user.system_requirements === "string" && user.system_requirements.length > 0) {
            parts.push(`# Plurnk System Requirements\n\n${user.system_requirements}`);
        }
        return parts.map((p) => p.replace(/\n+$/, "")).join("\n\n");
    }

    // Project the full request half of a packet to ChatMessage[] for the wire.
    // Engine calls this directly; the result is what provider.generate receives.
    static packetToWireMessages(packet: Packet): Array<{ role: string; content: string }> {
        return [
            { role: "system", content: PacketWire.renderSystemContent(packet.system) },
            { role: "user", content: PacketWire.renderUserContent(packet.user) },
        ];
    }

    // Measure the wire-rendered token cost of the curatable log section plus
    // the assembled total, using the provider's tokenizer. The budget
    // readout uses this so its subtotals match what actually ships — meta lines
    // and fences included — not a serialized approximation. `total` is measured
    // over whatever the packet currently holds, so the caller renders the budget
    // with a `{{tokensFree}}` placeholder, measures, then substitutes (the
    // placeholder/number length delta is negligible).
    static measureBudgetSections(packet: Packet, countTokens: CountTokens): {
        log: { entries: number; tokens: number; byScheme: Array<{ scheme: string; entries: number; tokens: number }> };
        total: number;
    } {
        const system: SystemSection = packet.system;
        const user: UserSection = packet.user;
        const logEntries: LogEntryView[] = Array.isArray(system.log) ? system.log : [];
        const logBody = logEntries.length > 0 ? PacketWire.#renderLogEntries(logEntries) : "";
        // Per-scheme log breakdown (§14.2 {§14.2-per-scheme-balance}): each entry's
        // render-weight grouped by the scheme it acted on, heaviest first — the
        // model's "what's eating my window" signal and its FOLD target. Render-
        // weight (not stored depth), consistent with the headline; tokenizing per
        // entry is free.
        const byScheme = new Map<string, { scheme: string; entries: number; tokens: number }>();
        for (const e of logEntries) {
            const scheme = e.target?.scheme ?? "—";
            const acc = byScheme.get(scheme) ?? { scheme, entries: 0, tokens: 0 };
            acc.entries += 1;
            acc.tokens += countTokens(PacketWire.#renderLogEntries([e]));
            byScheme.set(scheme, acc);
        }
        return {
            log: {
                entries: logEntries.length,
                tokens: logBody ? countTokens(`# Plurnk System Log\n\n${logBody}`) : 0,
                byScheme: [...byScheme.values()].toSorted((a, b) => b.tokens - a.tokens),
            },
            total: countTokens(PacketWire.renderSystemContent(system)) + countTokens(PacketWire.renderUserContent(user)),
        };
    }

    // Number each line of body as `<N>:\t<line>` — mirrors rummy
    // plugins/helpers.js numberLines. The leading digit prevents column-zero
    // fence collisions and gives the model line refs for free (`READ<42-46>`).
    // Used for READ@200 content; index-preview numbering is the framework's
    // job now (baked into the preview string — see renderHeredoc).
    static #numberLines(body: string, start = 1): string {
        if (!body) return "";
        const trailingNewline = body.endsWith("\n");
        const source = trailingNewline ? body.slice(0, -1) : body;
        const numbered = source.split("\n").map((line, i) => `${start + i}:\t${line}`).join("\n");
        return trailingNewline ? `${numbered}\n` : numbered;
    }

    // Tolerant JSON parser for log entries' rx/tx fields. The engine
    // pre-parses application/json mimetypes, but render may also receive
    // strings (legacy paths, manual tests). Returns null on parse failure.
    static #safeParse(s: string): unknown {
        try { return JSON.parse(s); } catch { return null; }
    }

    // Stable JSON: keys sorted alphabetically so the same meta produces the
    // same string across turns — prefix-cache friendly. Mirrors rummy
    // plugins/helpers.js canonicalJson.
    static #canonicalJson(obj: Record<string, unknown>): string {
        const keys = Object.keys(obj).sort();
        const sorted: Record<string, unknown> = {};
        for (const k of keys) sorted[k] = obj[k];
        return JSON.stringify(sorted);
    }

    // Wrap a body in heredoc fences. Leading `\n` always (separates the
    // opening fence from the first body character — necessary because
    // numbered bodies start with `1:\t…` which would otherwise collide
    // visually with the `:::FENCE` markers). Trailing `\n` only when the
    // body doesn't already end with one — otherwise you get a doubled
    // newline that renders as a blank line before the closing fence, which
    // reads as "the content has a trailing blank line" when actually it
    // doesn't. The body's own whitespace decides the shape.
    static #wrapHeredocBody(fence: string, body: string): string {
        const sep = body.endsWith("\n") ? "" : "\n";
        return `<<:::${fence}\n${body}${sep}:::${fence}`;
    }

    // Heredoc block for one channel of one entry. Fence is `URI#channel`
    // (the `<<:::FENCE` packet-rendering marker per wrapHeredocBody — a
    // projection is read-only context, NOT an emittable op, so it must not
    // wear the DSL op-fence; that conflation was the demo.sh corruption bug).
    // When `channel` is null/empty the fence is path-only —
    // this is the default-channel convention: the absence of `#channel` is
    // the addressing of the scheme's default channel, not a missing field.
    // Body is a mimetypes preview, rendered VERBATIM — the framework owns its
    // formatting (N:\t line numbers for text, source-annotated outline for
    // symbols, correct start-line for tail slices) and bakes it into the
    // preview string as of mimetypes 0.7.3, so the service must not re-number
    // it (re-numbering would double-prefix text and mis-number symbol
    // outlines — plurnk-mimetypes#8).
    static #renderHeredoc(uri: string, channel: string | null, body: string): string {
        const fence = channel ? `${uri}#${channel}` : uri;
        return PacketWire.#wrapHeredocBody(fence, body);
    }

    // Re-render a plurnk statement (from log_entries.tx) as the heredoc form
    // the model would have emitted. Used by the log render so the model sees
    // its own ops in its own native syntax — what it wrote, mirrored back.
    //
    // Faithfulness over cleverness: render the parts as recorded. `target.raw`
    // preserves exactly what the model wrote (URL with fragment, bare path,
    // etc.) instead of round-tripping through scheme/pathname/fragment fields.
    // Returns null when tx isn't a parseable PlurnkStatement (callers fall
    // back to the meta line alone).
    //
    // Signal renders to `[…]`:
    //   - array of strings (tags) → `[tag1,tag2]`
    //   - number (status code, e.g. SEND[200]) → `[200]`
    //   - string (runtime, e.g. EXEC[python]) → `[python]`
    //   - null/missing → omitted
    // All plurnk statements share the same syntactic frame; signal type
    // varies by op but renders uniformly.
    static #renderStatementHeredoc(tx: StatementTx | null): string | null {
        if (tx === null || typeof tx !== "object" || typeof tx.op !== "string" || tx.op.length === 0) return null;
        const op = tx.op;
        const suffix = typeof tx.suffix === "string" ? tx.suffix : "";
        let signalStr = "";
        const signal = tx.signal;
        if (Array.isArray(signal)) {
            const tags = signal.filter((t): t is string => typeof t === "string");
            if (tags.length > 0) signalStr = `[${tags.join(",")}]`;
        } else if (typeof signal === "number") {
            signalStr = `[${signal}]`;
        } else if (typeof signal === "string" && signal.length > 0) {
            signalStr = `[${signal}]`;
        }
        let targetStr = "";
        const target = tx.target;
        if (target !== null && target !== undefined && typeof target === "object" && typeof target.raw === "string") {
            targetStr = `(${target.raw})`;
        }
        let markerStr = "";
        const lm = tx.lineMarker;
        if (lm !== null && lm !== undefined && typeof lm === "object" && typeof lm.first === "number") {
            markerStr = typeof lm.last === "number" ? `<${lm.first},${lm.last}>` : `<${lm.first}>`;
        }
        let body: string;
        if (typeof tx.body === "string") body = tx.body;
        else if (tx.body !== null && tx.body !== undefined && typeof tx.body === "object" && typeof tx.body.raw === "string") body = tx.body.raw;
        else body = "";
        // Character-perfect: no padding around body. The body string IS
        // whatever the model wrote between the colons, including any leading
        // or trailing whitespace it chose. Adding `\n` here would inflate
        // single-line emissions into multi-line and nudge the model toward
        // verbose forms — and it would violate the grammar's "body content
        // is character-perfect" guarantee on the way back.
        return `<<${op}${suffix}${signalStr}${targetStr}${markerStr}:${body}:${op}${suffix}`;
    }

    // Render a (scheme, pathname) tuple as the URI the model should SEE.
    // Null scheme → bare pathname. The `file` scheme never reaches this
    // function because Engine.#extractTarget normalizes it to null at the
    // storage boundary; storage and wire output are uniform on this.
    static #renderModelUri(scheme: string | null | undefined, pathname: string | null | undefined): string {
        const path = pathname ?? "";
        if (scheme === null || scheme === undefined) return path;
        return `${scheme}://${path}`;
    }

    // Render one Log entry → a single bullet line carrying the meta JSON.
    // No body, no fence — every meaningful field is in the JSON. Naming
    // follows the uniform principle: `path` is identity (this log row's
    // own URI), `target` is the URI the action acted on. COPY/MOVE add
    // `source`; currently the engine emits target only (source plumbing
    // pending the COPY/MOVE-specific log shape pass).
    //
    // On error, status >= 400 signals the failure; the message lives in
    // the next packet's user.telemetry.errors[] per SPEC §15.1. (Forward:
    // meta will gain tokensBefore/After + linesBefore/After to convey
    // change scope without carrying the body content.)
    //
    // Per-entry render: one meta JSON line plus a body block that the model
    // can read to know what it did. Two body cases:
    //   1. READ@200 with content → render rx.content under the target fence.
    //      The model asked for content; show it the content. (Matcher is in
    //      meta.matcher, count is in meta.matches.)
    //   2. Every other op → re-emit tx as a heredoc in the model's native
    //      syntax. The model wrote this; mirror it back so the log is a true
    //      record of its actions instead of a row of opaque status codes.
    static #renderLogEntries(entries: LogEntryView[]): string {
        return entries.map((e) => {
            const meta: Record<string, unknown> = {};
            const coordinate = typeof e.coordinate === "string" ? e.coordinate : null;
            const op = typeof e.op === "string" && e.op.length > 0 ? e.op : null;
            if (coordinate !== null && op !== null) meta.path = `log://${coordinate}/${op}`;
            else if (coordinate !== null) meta.path = `log://${coordinate}`;
            if (typeof e.origin === "string") meta.origin = e.origin;
            // §14.5: the environment-delta cause (a sibling run or a scheme),
            // rendered when present; absent ⇒ the owning run itself (self).
            if (typeof e.source === "string" && e.source.length > 0) meta.run = e.source;
            if (op !== null) meta.op = op;
            if (typeof e.status === "number") meta.status = e.status;
            const target = PacketWire.#renderActionTarget(e.target);
            if (target !== null) meta.target = target;

            // Op-specific meta enrichment for READ: surface the matcher body
            // and match count when a body matcher was used. Without these, the
            // model can't distinguish "0 matches" from "empty content" — both
            // would render as a status-204 line. The matcher comes from the
            // stored statement (tx); the count from the result (rx).
            if (op === "READ") {
                const tx = e.tx;
                if (tx !== null && tx !== undefined && typeof tx === "object" && tx.body !== null && typeof tx.body === "object") {
                    if (typeof tx.body.raw === "string") meta.matcher = tx.body.raw;
                }
                const rx = (typeof e.rx === "string" ? PacketWire.#safeParse(e.rx) : e.rx) as RxView | null;
                if (rx !== null && typeof rx === "object" && typeof rx.matches === "number") {
                    meta.matches = rx.matches;
                }
            }

            const metaLine = `* ${PacketWire.#canonicalJson(meta)}`;

            // FOLD (indexed=0): the model collapsed this row to its one-line
            // summary (§6.3) — render the meta line only, eliding the body.
            // Re-OPEN restores it. The row stays listed; only its weight drops.
            if (e.folded === true) return metaLine;

            // READ@200: expose the response body. READ@204 (successfully empty —
            // 0 matcher hits, sentinel slice, or empty source) has no body to
            // render; the meta line carries the signal via `matches` / status code.
            if (op === "READ" && e.status === 200) {
                const rx = (typeof e.rx === "string" ? PacketWire.#safeParse(e.rx) : e.rx) as RxView | null;
                if (rx !== null && typeof rx === "object" && typeof rx.content === "string" && rx.content.length > 0) {
                    const fence = target ?? `log://${coordinate}`;
                    // Line-navigable mimetypes (text/markdown, text/plain,
                    // source code, etc.) get N:\t prefix per plurnk.md. Tree-
                    // navigable (JSON, XML, HTML) render verbatim — line
                    // numbers in the wrapper would collide with structural
                    // navigation (jsonpath/xpath) used on these formats.
                    // Classifier is consumer-side in this repo (SPEC.md §16.6).
                    const mimetype = typeof rx.mimetype === "string" ? rx.mimetype : "text/plain";
                    if (MimetypeBinary.isLineNavigableMimetype(mimetype)) {
                        const start = typeof rx.startLine === "number" ? rx.startLine : 1;
                        return `${metaLine}\n${PacketWire.#wrapHeredocBody(fence, PacketWire.#numberLines(rx.content, start))}`;
                    }
                    return `${metaLine}\n${PacketWire.#wrapHeredocBody(fence, rx.content)}`;
                }
            }
            // EDIT (§14.6): render the resulting span — the edited area as it
            // looks now — instead of the input statement. The meta line still
            // carries op + target, so "I EDITed X" stays legible; the body says
            // "and here's X now." Serves the model's own EDITs and the system
            // delta-EDITs (§14.5) identically. Empty span (content emptied) →
            // meta line only.
            if (op === "EDIT") {
                const rx = (typeof e.rx === "string" ? PacketWire.#safeParse(e.rx) : e.rx) as { span?: unknown } | null;
                if (rx !== null && typeof rx === "object" && typeof rx.span === "string") {
                    const fence = target ?? `log://${coordinate}`;
                    return rx.span.length > 0 ? `${metaLine}\n${PacketWire.#wrapHeredocBody(fence, rx.span)}` : metaLine;
                }
            }
            // Every other op: re-emit the model's statement. EXEC, SEND, COPY,
            // MOVE, FIND, OPEN, FOLD — each gets its native heredoc form back.
            // Without this the log row is a status code with no record of what
            // the model actually wrote, and the model has to back into its own
            // actions by inference (see reasoning.md trace from the pre-fix
            // count-files run).
            const heredoc = PacketWire.#renderStatementHeredoc(e.tx ?? null);
            if (heredoc !== null) return `${metaLine}\n${heredoc}`;
            return metaLine;
        }).join("\n");
    }

    static #renderActionTarget(target: ActionTarget | null | undefined): string | null {
        if (target === null || target === undefined) return null;
        const rendered = PacketWire.#renderModelUri(target.scheme, target.pathname);
        return rendered.length > 0 ? rendered : null;
    }

    // Render TelemetryEvent[] → meta line per event, optionally followed by
    // an N:\t-prefixed snippet block when the event carries `snippet` (the
    // convention plurnk-service uses for content-offset positions — model
    // sees its own offending bytes alongside the error, not an abstract
    // message it can't trace).
    //
    // Snippet renders verbatim — already N:\t-prefixed at production time
    // (Engine.#extractSnippet). The fence is `error://<line>` to give the
    // model a stable URI shape it can ignore or reference; the `error://`
    // scheme isn't writable, it just identifies "this block is locator
    // context, not addressable content."
    //
    // `snippet` is stripped from the meta JSON so the snippet appears once,
    // in the body block, not also as a quoted string in the meta.
    static #renderTelemetryErrors(errors: TelemetryError[]): string {
        return errors.map((e) => {
            const snippet = typeof e.snippet === "string" ? e.snippet : null;
            const meta: Record<string, unknown> = { ...e };
            if (snippet !== null) delete meta.snippet;
            const metaLine = `* ${PacketWire.#canonicalJson(meta)}`;
            if (snippet === null || snippet.length === 0) return metaLine;
            const line = typeof e.position?.line === "number" ? e.position.line : 0;
            const fence = `error://${line}`;
            return `${metaLine}\n${PacketWire.#wrapHeredocBody(fence, snippet)}`;
        }).join("\n");
    }
}
