// Packet → wire markdown projection. Single source of truth for how the
// Packet's ordered list of sections renders to ChatMessage.content
// strings the LLM receives. Engine imports this for the wire payload; the
// digest tool imports it to write byte-identical packetNNN.{system,user}.md
// files. No second implementation, no drift.
//
// Format: markdown. user picked it over rummy's XML and JSON alternatives
// 2026-05-22. Standard markdown idioms only — headers as section delimiters,
// fenced code blocks for entry bodies, lists for arrays. No invented
// separators. Models parse markdown natively.
//
// Section headers follow the `## Plurnk Service X` convention so the model
// sees consistent framing across every section it might receive. Sections
// with no content are omitted entirely (no empty headers in the wire).

import { MimetypeBinary } from "../content/index.ts";
import { renderAddress } from "./plurnk-uri.ts";
import type { GitStatus } from "./git-state.ts";

// PacketSection is the canonical packet shape: an ordered list of named,
// slotted sections (defined below). Sections arrive both from Engine's
// in-memory packet AND from `turns.packet` re-parsed by the digest — re-parsed
// leaf fields are untyped (SectionView), narrowed by the runtime `typeof`
// checks below (boundaries validate). Engine's RequestPacket is strict.
interface ActionTarget { scheme?: string | null; hostname?: string | null; port?: number | null; pathname?: string | null; fragment?: string | null }
// Only `body` is read off the log row's tx now — the mirror renders the model's WORK as content
// (PLAN/SEND bodies, EXEC commands, READ/FIND matchers), never the op's emission tag re-serialized.
interface StatementTx {
    body?: string | { raw?: unknown } | null;
}
interface RxView { content?: unknown; mimetype?: unknown; startLine?: unknown; matches?: unknown; itemsTokenTotal?: unknown }
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
    attrs?: unknown;
}
interface TelemetryError { position?: { line?: unknown }; [key: string]: unknown }
// One packet section: a named, slotted, ordered unit of rendered content. The
// stored section holds RENDERED markdown + a measured `tokens` weight — exactly
// what the digest re-parses and what the model saw. `slot` is the prompt-cache
// boundary (system = the cache-stable prefix; user = the per-turn tail); order
// within a slot is the render order. Empty `content` ⇒ the section is omitted.
export interface PacketSection {
    name: string;
    slot: "system" | "user";
    header: string | null;
    content: string;
    tokens: number;
}
// Loose view of a section re-parsed from `turns.packet` JSON (the digest path).
interface SectionView { name?: unknown; slot?: unknown; header?: unknown; content?: unknown; tokens?: unknown }
interface Packet { sections?: SectionView[] }
type CountTokens = (text: string) => number;

export default class PacketWire {
    // Render the sections in `slot` to one ChatMessage.content string. Sections
    // render in list order; empties are omitted (no empty headers on the wire);
    // each is `## {header}\n\n{content}` (or bare content when header is null),
    // trailing newlines stripped, joined with a blank line.
    static renderSlot(sections: SectionView[], slot: "system" | "user"): string {
        return sections
            .filter((s) => s.slot === slot)
            .map((s) => PacketWire.renderSection(s))
            .filter((p) => p.length > 0)
            .join("\n\n");
    }

    // One section → its markdown block (`## {header}\n\n{content}`, or bare
    // content when header is null/empty), trailing newlines stripped. Empty
    // content renders to "" so renderSlot drops it. This is the unit the
    // per-section `tokens` weight is measured over.
    static renderSection(s: SectionView): string {
        if (typeof s.content !== "string" || s.content.length === 0) return "";
        const header = typeof s.header === "string" && s.header.length > 0 ? s.header : null;
        return (header ? `## ${header}\n\n${s.content}` : s.content).replace(/\n+$/, "");
    }

    // The Active User Prompts section (§prompt-fold) — the OPPOSITE of the errors section:
    // bare HEREDOC bodies, no meta/link line; the heredoc fence (each prompt's own
    // plurnk://prompt/<loop>/<seq> address) IS the link. Every prompt the current loop holds
    // renders in order (typically one; an active loop admits injected prompts). The body is
    // `N:\t` LINE-NUMBERED inside the fence — a SECURITY boundary: numbered, fenced prompt text
    // can't spoof other parts of the packet (a prompt line `## Plurnk Service Errors` reads as
    // `3:\t## …`, plainly inside the prompt, not a real section). A fat prompt replays every turn,
    // so PLURNK_PROMPT_PREVIEW_CHARS caps it: over the cap, render a pointer placeholder instead of
    // the body — the model OPENs/READs the entry to see it whole (never lost). cap < 0 = no cap.
    static renderActivePrompts(rows: Array<{ content: string; pathname: string }>, cap: number): string {
        return rows.map((r) => {
            const addr = renderAddress("plurnk", r.pathname);
            if (cap >= 0 && r.content.length > cap) return `[ Prompt exceeds preview limit. Full content: ${addr} ]`;
            return PacketWire.#wrapHeredocBody(addr, PacketWire.#numberLines(r.content));
        }).join("\n\n");
    }

    // The errors section content: the structured telemetry events rendered to
    // meta lines (+ snippet blocks). "" when empty (the section is omitted). The
    // events are ALSO kept structured on the packet (packet.telemetryErrors) —
    // ephemeral (the buffer drains on read), so the packet is their only home.
    static renderErrors(errors: unknown): string {
        const events = Array.isArray(errors) ? (errors as TelemetryError[]) : [];
        return events.length > 0 ? PacketWire.#renderTelemetryErrors(events) : "";
    }

    // The Child Streams / Child Runs sections (§child-orientation) — the OPPOSITE of advice: terse
    // `* <status> <path>` pointers (same shape as the errors section) to the live things the run holds,
    // so the model SEES its open streams + unconcluded workers each turn and reasons for itself (READ /
    // OPEN / KILL via the path). Orienting state, never an instruction. "" when none → section omitted.
    static renderChildPointers(rows: unknown): string {
        const items = Array.isArray(rows) ? (rows as Array<{ status: unknown; path: unknown }>) : [];
        return items.map((r) => `* ${String(r.status)} ${String(r.path)}`).join("\n");
    }

    // The git section content: the working-tree summary. "" when absent.
    static renderGit(git: unknown): string {
        return git === null || git === undefined ? "" : PacketWire.#renderGitState(git as GitStatus);
    }

    // The log section's content: the model's curated rows rendered to markdown
    // (the same #renderLogEntries the wire ships). Empty log → "" (omitted).
    static renderLog(entries: unknown, countTokens: CountTokens): string {
        const log = Array.isArray(entries) ? (entries as LogEntryView[]) : [];
        return log.length > 0 ? PacketWire.#renderLogEntries(log, countTokens) : "";
    }

    // Read one section's content by name off a packet (Engine's or re-parsed).
    // The legible accessor — consumers name the section they want instead of
    // indexing a fixed shape. Missing section / non-string content → "".
    static sectionContent(packet: Packet, name: string): string {
        const s = packet.sections?.find((x) => x.name === name);
        return typeof s?.content === "string" ? s.content : "";
    }

    // Project a packet to the request ChatMessage[] for the wire: one message
    // per slot. Engine calls this directly; the result is what provider.generate
    // receives. The digest calls renderSlot for byte-identical packetNNN files.
    static packetToWireMessages(packet: Packet): Array<{ role: string; content: string }> {
        const sections = packet.sections ?? [];
        return [
            { role: "system", content: PacketWire.renderSlot(sections, "system") },
            { role: "user", content: PacketWire.renderSlot(sections, "user") },
        ];
    }

    // Measure the curatable log section's budget subtotals from the STRUCTURED
    // log (the foldable unit), using the provider's tokenizer — meta lines and
    // fences included, matching what ships. Feeds the per-turn rollup (chronological;
    // the grinder folds the newest turn) and the FOLD unit (heaviest entries) — the
    // two budget levers the model can pull (§tokenomics {§tokenomics-turn-totals},
    // {§tokenomics-largest-entries}). Build-time only; the stored log section is
    // the rendered result. §tokenomics-render-weight-budget
    static measureLogBudget(entries: unknown, countTokens: CountTokens): {
        entries: number; tokens: number;
        byTurn: Array<{ turn: string; tokens: number }>;
        largest: Array<{ path: string; tokens: number }>;
    } {
        const logEntries: LogEntryView[] = Array.isArray(entries) ? (entries as LogEntryView[]) : [];
        const logBody = logEntries.length > 0 ? PacketWire.#renderLogEntries(logEntries, countTokens) : "";
        const HEAVIEST_COUNT = 5;
        const byTurn = new Map<string, number>();
        const perEntry: Array<{ path: string; tokens: number }> = [];
        for (const e of logEntries) {
            const weight = countTokens(PacketWire.#renderLogEntries([e], countTokens));
            const coordinate = typeof e.coordinate === "string" ? e.coordinate : null;
            const op = typeof e.op === "string" && e.op.length > 0 ? e.op : null;
            // Turn = the loop_seq/turn_seq prefix of the coordinate
            // (log:///<loop_seq>/<turn_seq>/<sequence>); the sequence drops off.
            if (coordinate !== null) {
                const turn = coordinate.split("/").slice(0, 2).join("/");
                byTurn.set(turn, (byTurn.get(turn) ?? 0) + weight);
            }
            const path = PacketWire.#entryPath(coordinate, op);
            if (path !== null) perEntry.push({ path, tokens: weight });
        }
        return {
            entries: logEntries.length,
            tokens: logBody ? countTokens(`## Plurnk Service Log\n\n${logBody}`) : 0,
            byTurn: [...byTurn.entries()]
                .map(([turn, tokens]) => ({ turn, tokens }))
                .toSorted((a, b) => {
                    const [al, at] = a.turn.split("/").map(Number);
                    const [bl, bt] = b.turn.split("/").map(Number);
                    return al - bl || at - bt;
                }),
            largest: perEntry.toSorted((a, b) => b.tokens - a.tokens).slice(0, HEAVIEST_COUNT),
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

    // The single content-body renderer EVERY output-emitting op routes through, so the line-number
    // convention the model orients on can't drift: line-navigable mimetypes (text/*) get the `N:\t`
    // prefix from `startLine`; tree-navigable (JSON/XML/HTML) render verbatim so jsonpath/xpath
    // isn't shifted. Empty content ⇒ "" (the meta line stands alone). §render-rule-line-navigable-prefix
    static #renderContentBody(fence: string, content: string, mimetype: string, startLine: number | null = 1): string {
        if (content.length === 0) return "";
        // Line-navigable text gets the `N:\t` source-line prefix from startLine. `startLine === null`
        // means the content is ALREADY source-numbered — a matcher result whose lines carry their own
        // (non-contiguous) source numbers like `143:\t…`; re-numbering would double it to `1:\t143:\t…`
        // (plurnk.md:32 — one source-line prefix). Render verbatim. §render-rule-line-navigable-prefix
        const rendered = MimetypeBinary.isLineNavigableMimetype(mimetype) && startLine !== null
            ? PacketWire.#numberLines(content, startLine)
            : content;
        return PacketWire.#wrapHeredocBody(fence, rendered);
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

    // Render a (scheme, pathname) tuple as the URI the model should SEE.
    // Null scheme → bare pathname. The `file` scheme never reaches this
    // function because Dispatcher.#extractTarget normalizes it to null at the
    // storage boundary; storage and wire output are uniform on this.
    static #renderModelUri(scheme: string | null | undefined, pathname: string | null | undefined): string {
        const path = pathname ?? "";
        if (scheme === null || scheme === undefined) return path;
        return renderAddress(scheme, path);
    }

    // Render one Log entry → a single bullet line carrying the meta JSON.
    // No body, no fence — every meaningful field is in the JSON. Naming
    // follows the uniform principle: `path` is identity (this log row's
    // own URI), `target` is the URI the action acted on. COPY/MOVE add
    // `source`; currently the engine emits target only (source plumbing
    // pending the COPY/MOVE-specific log shape pass).
    //
    // On error, status >= 400 signals the failure; the message lives in
    // the next packet's user.telemetry.errors[] per SPEC §telemetry. (Forward:
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
    // The log:/// handle the model sees for an entry — its FOLD target
    // (§open-fold) and the label the budget's heaviest-entries readout reuses,
    // so the readout names an entry exactly as the log does.
    static #entryPath(coordinate: string | null, op: string | null): string | null {
        if (coordinate === null) return null;
        return op !== null ? `log:///${coordinate}/${op}` : `log:///${coordinate}`;
    }

    static #renderLogEntries(entries: LogEntryView[], countTokens: CountTokens): string {
        return entries.map((e) => {
            const meta: Record<string, unknown> = {};
            const coordinate = typeof e.coordinate === "string" ? e.coordinate : null;
            const op = typeof e.op === "string" && e.op.length > 0 ? e.op : null;
            const path = PacketWire.#entryPath(coordinate, op);
            if (path !== null) meta.path = path;
            if (typeof e.origin === "string") meta.origin = e.origin;
            // §env-delta: the environment-delta cause (a sibling run or a scheme),
            // rendered when present; absent ⇒ the owning run itself (self).
            if (typeof e.source === "string" && e.source.length > 0) meta.run = e.source;
            if (op !== null) meta.op = op;
            if (typeof e.status === "number") meta.status = e.status;
            const target = PacketWire.#renderActionTarget(e.target);
            if (target !== null) meta.target = target;
            // EXEC's output is a separate stream entry (§exec-stream); its address rides in a
            // `stream` link, distinct from `target` (the cwd / executable path it ran in).
            if (op === "EXEC" && e.attrs !== null && typeof e.attrs === "object" && typeof (e.attrs as { stream?: unknown }).stream === "string") {
                meta.stream = (e.attrs as { stream: string }).stream;
            }

            // Parse rx once — reused for the matcher/items enrichment and the body.
            const rx = (typeof e.rx === "string" ? PacketWire.#safeParse(e.rx) : e.rx) as RxView | null;

            // READ + FIND enrichment: the matcher body (from tx) + `items`, the count
            // of rows the op returned — a matcher's hits, or a bare catalog FIND's entry
            // count. Without it the model can't tell "0 results" from "empty content",
            // nor weigh a re-FIND. `matches` when the dispatch tallied it; else a FIND
            // body is a JSON array whose length IS the count.
            let items: number | null = null;
            if (op === "READ" || op === "FIND") {
                const tx = e.tx;
                if (tx !== null && tx !== undefined && typeof tx === "object" && tx.body !== null && typeof tx.body === "object") {
                    if (typeof tx.body.raw === "string") meta.matcher = tx.body.raw;
                }
                if (rx !== null && typeof rx === "object" && typeof rx.matches === "number") {
                    items = rx.matches;
                } else if (op === "FIND" && rx !== null && typeof rx === "object" && typeof rx.content === "string") {
                    const parsed = PacketWire.#safeParse(rx.content);
                    if (Array.isArray(parsed)) items = parsed.length;
                }
                // The matched set's content weight (sum of the entries' live channel tokens) — the
                // FIND self-describes its hits' READ-cost; carries the per-scheme roll-up in the foist.
                if (op === "FIND" && rx !== null && typeof rx === "object" && typeof rx.itemsTokenTotal === "number") {
                    meta.itemsTokenTotal = rx.itemsTokenTotal;
                }
            }

            // The foldable body — computed ALWAYS (folded too), because `tokens` measures it: for
            // an open row that's what a FOLD would save, for a folded row what an OPEN would cost.
            // "" ⇒ genuinely no body (an empty FIND, an empty EDIT span, a @204).
            let body = "";
            if (op === "FIND" && e.status === 200 && items === 0) {
                // Empty FIND result → no body. items:0 already says "empty"; rendering [] under a
                // fence is redundant noise. (The always-foisted empty known:///** / unknown:///**
                // workspace rows are the common case.)
                body = "";
            } else if ((op === "READ" || op === "FIND") && e.status === 200 &&
                rx !== null && typeof rx === "object" && typeof rx.content === "string" && rx.content.length > 0) {
                // READ@200 / FIND@200: the content READ pulled, or the catalog rows / matched
                // entries FIND returned (§render-rule-find-renders-result) — the turn-0 foisted
                // FIND(scheme:///**) reaches the packet here, as does the exec-stream injector's
                // foisted READ of the channel. #renderContentBody applies the line-number convention
                // (§render-rule-line-navigable-prefix / §render-rule-tree-navigable-verbatim).
                const mimetype = typeof rx.mimetype === "string" ? rx.mimetype : "text/plain";
                // startLine === null is the matcher-result signal (already source-numbered → verbatim);
                // a number numbers from it; absent → 1 (whole-content default).
                const start = rx.startLine === null ? null : (typeof rx.startLine === "number" ? rx.startLine : 1);
                body = PacketWire.#renderContentBody(target ?? `log:///${coordinate}`, rx.content, mimetype, start);
            } else if (op === "EDIT" && rx !== null && typeof rx === "object" && typeof (rx as { span?: unknown }).span === "string") {
                // EDIT (§edit-result-render): the resulting span as it looks now. editedSpan already
                // line-numbered it with the changed region's REAL offsets (e.g. 50:\t…), so wrap
                // verbatim — re-numbering here would double it (1:\t50:\t…) and lose the true line
                // position. Empty span (content emptied) ⇒ no body — the meta line stands alone.
                const span = (rx as { span: string }).span;
                if (span.length > 0) body = PacketWire.#wrapHeredocBody(target ?? `log:///${coordinate}`, span);
            } else if (op === "EXEC" && e.tx !== null && e.tx !== undefined && typeof (e.tx as { body?: unknown }).body === "string") {
                // EXEC: the literal command body, :::-fenced + line-numbered at the op's log address —
                // the model sees what it ran and can reference lines of its own code. The OUTPUT is a
                // SEPARATE stream (meta.stream), surfaced by the injector, never re-emitted here. §exec-stream
                body = PacketWire.#renderContentBody(path ?? `log:///${coordinate}`, (e.tx as { body: string }).body, "text/plain");
            } else if ((op === "PLAN" || op === "SEND") && e.tx !== null && e.tx !== undefined) {
                // PLAN's plan / SEND's message ride into the log as N:\t content at the op's log address —
                // the log mirrors the model's WORK, NEVER a repeated <<OP:…:OP tag (tags are emission
                // syntax, not the log paradigm). Bodyless ops (COPY/MOVE/OPEN/FOLD, a non-200 READ/FIND
                // whose matcher already rides in meta, a span-less EDIT) fall through to their meta line.
                const b = e.tx.body;
                const opBody = typeof b === "string" ? b
                    : b !== null && typeof b === "object" && typeof b.raw === "string" ? b.raw : "";
                if (opBody.length > 0) body = PacketWire.#renderContentBody(path ?? `log:///${coordinate}`, opBody, "text/plain");
                // §run-scheme-collect: an injected SEND (a child run's concluded deliverable surfaced in
                // the parent) has no authored tx body — its payload is the deliverable in rx (a raw string,
                // not the {status} envelope a model SEND gets). Surface it so a child's 2xx reaches the
                // parent OPEN (born-open at the insert), never a bodyless `*` row.
                else if (op === "SEND" && opBody.length === 0 && typeof e.rx === "string" && e.rx.length > 0) {
                    body = PacketWire.#renderContentBody(path ?? `log:///${coordinate}`, e.rx, "text/plain");
                }
            } else if (op === "error") {
                // §telemetry — a parse-error row is a LOG ITEM; its body is the parser message, which
                // carries the content-offset `line:col`. The model resolves that line against its own
                // emission — READ the folded `model` mirror row (§model-entry) — so no snippet is embedded.
                // Foldable like any body; the errors section keeps only a pointer (status + coordinate).
                const detail = (rx !== null && typeof rx === "object" ? rx : {}) as { message?: unknown };
                if (typeof detail.message === "string" && detail.message.length > 0) {
                    body = PacketWire.#wrapHeredocBody(path ?? `log:///${coordinate}`, detail.message);
                }
            } else if (op === "model") {
                // §model-entry — the model's own verbatim emission, mirrored back so it sees exactly
                // what it produced. Line-numbered like all content (the parser reports errors by line,
                // so the model can reason about its own syntax error). Folded by default → just the
                // meta line until OPENed; the turn-0 exemplar is born open (the worked example).
                if (rx !== null && typeof rx === "object" && typeof rx.content === "string" && rx.content.length > 0) {
                    const mimetype = typeof rx.mimetype === "string" ? rx.mimetype : "text/vnd.plurnk";
                    body = PacketWire.#renderContentBody(path ?? `log:///${coordinate}`, rx.content, mimetype);
                }
            }

            // tokens on EVERY row (0 when there's genuinely no body) so the model can always weigh
            // it; for a folded row this is the cost an OPEN would add. items present even at 0.
            if (items !== null) meta.items = items;
            // 0 for a genuinely empty body — never call countTokens("") (some providers return
            // undefined for it, which JSON.stringify would drop, leaving the row with no tokens).
            meta.tokens = body.length > 0 ? countTokens(body) : 0;

            // Body-state marker — body-aware so `-` never sits on a bodyless row:
            // `*` no body (nothing to OPEN) · `+` open (body shown) · `-` folded (OPEN to expand).
            const marker = body.length === 0 ? "*" : e.folded === true ? "-" : "+";
            const metaLine = `${marker} ${PacketWire.#canonicalJson(meta)}`;
            // Render the body only when OPEN; a folded row is its meta line alone (body hidden).
            return (e.folded !== true && body.length > 0) ? `${metaLine}\n${body}` : metaLine;
        }).join("\n");
    }

    static #renderActionTarget(target: ActionTarget | null | undefined): string | null {
        if (target === null || target === undefined) return null;
        // An authority-bearing target (run://<name> — the run IS the authority, §run-scheme;
        // a web host http://host/path) keeps its name in `hostname`. Without it a spawn renders
        // as a bare `run://`, indistinguishable across workers — the model goes blind to what it
        // spawned and re-spawns. Reconstruct the authority form when a hostname is present;
        // namespace schemes (plurnk/known) fold their authority into the path and fall through.
        const host = typeof target.hostname === "string" && target.hostname.length > 0 ? target.hostname : null;
        const rendered = host !== null && typeof target.scheme === "string" && target.scheme.length > 0
            ? `${target.scheme}://${host}${target.port ? `:${target.port}` : ""}${target.pathname ?? ""}`
            : PacketWire.#renderModelUri(target.scheme, target.pathname);
        if (rendered.length === 0) return null;
        // The channel fragment (#stdout/#stderr) is part of the address — a stream delta has to
        // say WHICH channel it is, not just the entry. §exec-stream
        const fragment = typeof target.fragment === "string" && target.fragment.length > 0 ? `#${target.fragment}` : "";
        return rendered + fragment;
    }

    static #renderGitState(git: GitStatus): string {
        const sync = git.ahead > 0 || git.behind > 0 ? ` (↑${git.ahead} ↓${git.behind})` : "";
        return `branch \`${git.branch}\`${sync} — ${git.staged} staged, ${git.unstaged} unstaged, ${git.untracked} untracked`;
    }

    static #renderTelemetryErrors(errors: TelemetryError[]): string {
        // Uniform projection off the formal TelemetryEvent envelope (grammar TelemetryEvent.json):
        // render each error by its typed `position`, never by sniffing `kind`. A LogCoordinate is a
        // terse `<status> log:///<coord>` link to the row (the row holds the term + detail); a
        // ContentOffset points the model at the line in its own born-OPEN emission (§model-entry).
        // No JSON dump — the packet teaches, the row carries the body.
        return errors.map((e) => {
            const ev = e as { kind?: string; status?: number; position?: { type?: string; coordinate?: string; line?: number; column?: number } };
            const pos = ev.position;
            if (pos?.type === "log-coordinate") return `* ${ev.status ?? ""} log:///${pos.coordinate}`.replace(/ +/g, " ");
            if (pos?.type === "content-offset") return `* ${ev.kind ?? "error"} ${pos.line}:${pos.column}`;
            return `* ${ev.kind ?? "error"}`;
        }).join("\n");
    }
}
