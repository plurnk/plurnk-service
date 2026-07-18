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
interface RxView { content?: unknown; mimetype?: unknown; startLine?: unknown; matches?: unknown; itemsTokenTotal?: unknown; overflow?: unknown }
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


    // The errors section content: the structured telemetry events rendered to
    // meta lines (+ snippet blocks). "" when empty (the section is omitted). The
    // events are ALSO kept structured on the packet (packet.telemetryErrors) —
    // ephemeral (the buffer drains on read), so the packet is their only home.
    static renderErrors(errors: unknown): string {
        const events = Array.isArray(errors) ? (errors as TelemetryError[]) : [];
        return events.length > 0 ? PacketWire.#renderTelemetryErrors(events) : "";
    }

    // The Child Streams / Child Runs sections (§child-orientation) — the OPPOSITE of advice: terse
    // `* <status> <path>` pointers (same shape as the errors section) to the live things the worker holds,
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

    // §jsonplurnk — the Note that leads the Log's fenced block, teaching the one carve-out inline
    // plus the token semantics (#466: a model-facing number defines itself where it appears — an
    // undefined `tokens` beside `itemsTokenTotal` read as 577-vs-6127 unreliability in run59).
    static #JSONPLURNK_NOTE = "Note: jsonplurnk is otherwise-valid JSON in which each `body` value, when present, is a HEREDOC-style `<<:::tag … :::tag` block. `tokens` is the ruler-weight of a row's body in this packet — the room it takes (what OPEN adds, what FOLD saves); a FIND's `itemsTokenTotal` is the ruler-weight of the matched entries themselves (the room READing them takes). These are curation weights (the model-agnostic ruler), not dollars.";

    // The log section's content: the model's curated rows as a fenced `jsonplurnk` array (§jsonplurnk).
    // Empty log → "" (the section is omitted).
    static renderLog(entries: unknown, countTokens: CountTokens): string {
        const log = Array.isArray(entries) ? (entries as LogEntryView[]) : [];
        if (log.length === 0) return "";
        const items = PacketWire.#renderLogEntries(log, countTokens);
        // The opening fence is DYNAMIC — one backtick longer than the longest run in any body — so a
        // code sample inside a body can never close the block early (CommonMark closes a fence only on
        // a line of ≥ its own length). §jsonplurnk-dynamic-fence
        const longestTicks = Math.max(0, ...[...items.matchAll(/`+/g)].map((m) => m[0].length));
        const fence = "`".repeat(Math.max(3, longestTicks + 1));
        return `${PacketWire.#JSONPLURNK_NOTE}\n\n${fence}jsonplurnk\n[\n${items}\n]\n${fence}`;
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
        const logBody = logEntries.length > 0 ? PacketWire.renderLog(logEntries, countTokens) : "";
        const HEAVIEST_COUNT = 5;
        const byTurn = new Map<string, number>();
        const perEntry: Array<{ path: string; tokens: number }> = [];
        for (const e of logEntries) {
            // Two weights, two purposes (#466 — one labeled semantic per number): the row's FULL
            // render (meta line + fences + body) composes the turn rollup — the room the turn takes in
            // the packet; the heaviest list carries the row's BODY weight — the FOLD unit, the SAME
            // number the row's own `tokens` shows, so the budget and the log can never disagree
            // about one row. A bodyless row is no FOLD target and never ranks.
            const bodyPrice: number[] = [];
            const weight = countTokens(PacketWire.#renderLogEntries([e], countTokens, bodyPrice));
            const coordinate = typeof e.coordinate === "string" ? e.coordinate : null;
            const op = typeof e.op === "string" && e.op.length > 0 ? e.op : null;
            // Turn = the loop_seq/turn_seq prefix of the coordinate
            // (log:///<loop_seq>/<turn_seq>/<sequence>); the sequence drops off.
            if (coordinate !== null) {
                const turn = coordinate.split("/").slice(0, 2).join("/");
                byTurn.set(turn, (byTurn.get(turn) ?? 0) + weight);
            }
            const path = PacketWire.#entryPath(coordinate, op);
            if (path !== null && (bodyPrice[0] ?? 0) > 0) perEntry.push({ path, tokens: bodyPrice[0] });
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
        // #370 — a null scheme is a workspace file, whose member key is /rel but whose MODEL-FACING
        // form is the bare relative path (the catalog lists data/users.json; FIND returns it; the
        // model types it). Rendering /data/users.json minted a second spelling of the same file.
        if (scheme === null || scheme === undefined) return path.replace(/^\//, "");
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

    // `collectBodyTokens`, when supplied, receives each row's body weight (the rendered meta.tokens)
    // in order — the FOLD unit measureLogBudget ranks, guaranteed identical to what the row shows.
    // §arrival-law (#499) — the pushed-lane bound: another actor's text rides OPEN only up to
    // the preview (N lines AND 80×N chars — the char cap guards single-line bombs); over, the
    // head rides with the cut stated and the address for a deliberate pull. run111 entry 56:
    // a child's ratified 19,363-token deliverable landed whole in its parent and cascaded.
    static #arrivalPreview(text: string): { text: string; cut: boolean } {
        const maxLines = Number(process.env.PLURNK_SERVICE_ARRIVAL_PREVIEW_LINES ?? "16");
        const maxChars = 80 * maxLines;
        const lines = text.split("\n");
        if (lines.length <= maxLines && text.length <= maxChars) return { text, cut: false };
        const head = lines.slice(0, maxLines).join("\n").slice(0, maxChars);
        return { text: head, cut: true };
    }

    static #renderLogEntries(entries: LogEntryView[], countTokens: CountTokens, collectBodyTokens?: number[]): string {
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

            // §log-row-self-explains — a FAILED op row carries its failure message ON THE META LINE,
            // so the record explains itself in every packet, folded or open. The old shape (a bare
            // status; the message buried in an rx no render shows) is what sent the wildcard model
            // theorizing "SEND[409] probably means bad request?" for 201s, and the jumbo model
            // chasing a phantom "engine error" off a message-less item. The row IS the model's op
            // result — it states its own why; the errors section stays a terse pointer at it.
            if (typeof e.status === "number" && e.status >= 400 && rx !== null && typeof rx === "object") {
                const why = (rx as { error?: unknown; reason?: unknown; message?: unknown });
                const text = typeof why.error === "string" ? why.error : typeof why.reason === "string" ? why.reason : typeof why.message === "string" ? why.message : null;
                if (text !== null && text.length > 0) meta.error = text;
            }

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
                if (op === "FIND" && rx !== null && typeof rx === "object" && typeof rx.overflow === "number") {
                    items = rx.overflow; // §find-count-not-contents — the full match count, though the rows weren't enumerated
                } else if (rx !== null && typeof rx === "object" && typeof rx.matches === "number") {
                    items = rx.matches;
                } else if (op === "FIND" && rx !== null && typeof rx === "object" && typeof rx.content === "string") {
                    const parsed = PacketWire.#safeParse(rx.content);
                    if (Array.isArray(parsed)) items = parsed.length;
                }
                // The matched set's content weight (sum of the entries' live channel tokens) — the
                // FIND self-describes its hits' READ-weight; carries the per-scheme roll-up in the foist.
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
                // §arrival-law — a foisted READ of a prompt path is PUSHED content (user- or
                // sibling-authored); the render-side preview bounds it like any arrival, closing
                // the single-line char-bomb the line-slice alone cannot cut (line markers cannot
                // cut mid-line; the render can). Model-authored READs stay self-invited — untouched.
                const promptPush = e.origin === "plurnk" && op === "READ"
                    && e.target !== null && typeof e.target === "object" && (e.target as { scheme?: string }).scheme === "plurnk"
                    && String((e.target as { pathname?: string }).pathname ?? "").startsWith("/prompt/");
                if (promptPush) {
                    const arrival = PacketWire.#arrivalPreview(rx.content);
                    body = PacketWire.#renderContentBody(target ?? `log:///${coordinate}`, arrival.text, mimetype, start);
                    if (arrival.cut) body += `\n… arrival preview — the full prompt is ${rx.content.split("\n").length} line(s), ${rx.content.length} chars: READ ${target}`;
                } else {
                    body = PacketWire.#renderContentBody(target ?? `log:///${coordinate}`, rx.content, mimetype, start);
                }
            } else if ((op === "EDIT" || op === "COPY" || op === "MOVE") && rx !== null && typeof rx === "object" && (typeof (rx as { span?: unknown }).span === "string" || typeof (rx as { body?: unknown }).body === "string")) {
                // EDIT (§edit-result-render): the resulting span as it looks now. editedSpan already
                // line-numbered it with the changed region's REAL offsets (e.g. 50:\t…), so wrap
                // verbatim — re-numbering here would double it (1:\t50:\t…) and lose the true line
                // position. Empty span (content emptied) ⇒ no body — the meta line stands alone.
                // The inline entry-scheme EDIT delivers the span under `span`; a PROPOSED file EDIT's
                // accept delivers the same span under `body` (the generic accept-rx key) — render either.
                const r = rx as { span?: string; body?: string };
                const span = typeof r.span === "string" ? r.span : (r.body ?? "");
                if (span.length > 0) body = PacketWire.#wrapHeredocBody(target ?? `log:///${coordinate}`, span);
            } else if (op === "EXEC" && e.tx !== null && e.tx !== undefined && typeof (e.tx as { body?: unknown }).body === "string") {
                // EXEC: the literal command body, :::-fenced + line-numbered at the op's log address —
                // the model sees what it ran and can reference lines of its own code. The OUTPUT is a
                // SEPARATE stream (meta.stream), surfaced by the injector, never re-emitted here. §exec-stream
                body = PacketWire.#renderContentBody(path ?? `log:///${coordinate}`, (e.tx as { body: string }).body, "text/plain");
            } else if ((op === "PLAN" || op === "SEND" || op === "WORK" || op === "FORK") && e.tx !== null && e.tx !== undefined) {
                // PLAN's plan / SEND's message / WORK's & FORK's seed task ride into the log as N:\t
                // content at the op's log address — a dispatch's record IS the task it dispatched, so
                // the next turn reads what each worker is doing (the spawn-then-retask confusion was
                // this body missing: the log showed "spawned worker-db" with no task). The log
                // mirrors the model's WORK, NEVER a repeated <<OP:…:OP tag (tags are emission
                // syntax, not the log paradigm). Bodyless ops (COPY/MOVE/OPEN/FOLD, a non-200 READ/FIND
                // whose matcher already rides in meta, a span-less EDIT) fall through to their meta line.
                const b = e.tx.body;
                const opBody = typeof b === "string" ? b
                    : b !== null && typeof b === "object" && typeof b.raw === "string" ? b.raw : "";
                if (opBody.length > 0) body = PacketWire.#renderContentBody(path ?? `log:///${coordinate}`, opBody, "text/plain");
                // §worker-scheme-collect: an injected SEND (a child worker's concluded deliverable surfaced in
                // the parent) has no authored tx body — its payload is the deliverable in rx (a raw string,
                // not the {status} envelope a model SEND gets). Surface it so a child's 2xx reaches the
                // parent OPEN (born-open at the insert), never a bodyless `*` row.
                else if (op === "SEND" && opBody.length === 0 && typeof e.rx === "string" && e.rx.length > 0) {
                    // §arrival-law — the deliverable is PUSHED content: preview-bounded, never whole-by-default.
                    const arrival = PacketWire.#arrivalPreview(e.rx);
                    body = PacketWire.#renderContentBody(path ?? `log:///${coordinate}`, arrival.text, "text/plain");
                    if (arrival.cut) body += `\n… arrival preview — the full deliverable is ${e.rx.split("\n").length} lines: READ worker://${(e.target && typeof e.target === "object" && "pathname" in e.target ? String((e.target as { pathname?: string }).pathname ?? "") : "").replace(/^\//, "")}`;
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
            // it; for a folded row this is the room an OPEN would add. items present even at 0.
            if (items !== null) meta.items = items;
            // 0 for a genuinely empty body — never call countTokens("") (some providers return
            // undefined for it, which JSON.stringify would drop, leaving the row with no tokens).
            meta.tokens = body.length > 0 ? countTokens(body) : 0;
            collectBodyTokens?.push(meta.tokens as number);
            // lines beside tokens on any row with a navigable body — the count of `N:\t`-numbered
            // lines (fences and unnumbered prose don't count), so the model can plan a <start,end>
            // slice before paying for an OPEN. Omitted when the body isn't line-addressable.
            if (body.length > 0) {
                const navigable = body.split("\n").filter((l) => /^\d+:\t/.test(l)).length;
                if (navigable > 0) meta.lines = navigable;
            }

            // §jsonplurnk — the `display` field (grammar-ratified name #437) replaces the old -/+/*
            // glyph: `none` (no body, nothing to OPEN), `folded` (body exists, hidden — OPEN to expand),
            // `open` (body shown). `display:none` mirrors CSS the model knows; `folded`/`open` echo the
            // FOLD/OPEN ops. The one deviation from valid JSON: an OPEN row appends its heredoc body as a
            // raw `body` value (unescaped, delimited by its <<:::tag … :::tag fence). §jsonplurnk
            const display = body.length === 0 ? "none" : e.folded === true ? "folded" : "open";
            meta.display = display;
            const obj = PacketWire.#canonicalJson(meta);
            return display === "open" ? obj.replace(/\}$/, `,"body":\n${body}\n}`) : obj;
        }).join(",\n");
    }

    static #renderActionTarget(target: ActionTarget | null | undefined): string | null {
        if (target === null || target === undefined) return null;
        // An authority-bearing target (worker://<name> — the worker IS the authority, §worker-scheme;
        // a web host http://host/path) keeps its name in `hostname`. Without it a spawn renders
        // as a bare `worker://`, indistinguishable across workers — the model goes blind to what it
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
