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

import { Validator, type LineMarker, type ProblemDetails, type TextRegion } from "@plurnk/plurnk-contracts";
import { Results as SchemeResults } from "@plurnk/plurnk-schemes";
import { renderAddress } from "./plurnk-uri.ts";
import { encodePathParens } from "./path-decode.ts";
import type { GitStatus } from "./git-state.ts";
import LogBody from "./LogBody.ts";
import {
    assertEditReceipt,
    assertResourceEffects,
    type EditReceipt,
} from "../content/index.ts";

const editReceiptRevisionChars = (): number => {
    const raw = process.env.PLURNK_SERVICE_EDIT_RECEIPT_REVISION_CHARS;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
        throw new Error(`PLURNK_SERVICE_EDIT_RECEIPT_REVISION_CHARS must be a safe integer from 1 through 64, got ${JSON.stringify(raw)}`);
    }
    return value;
};

const previewBounds = (): { lines: number; chars: number } => {
    const rawLines = process.env.PLURNK_SERVICE_PREVIEW_LINES;
    const rawChars = process.env.PLURNK_SERVICE_PREVIEW_CHARS;
    const lines = Number(rawLines);
    const chars = Number(rawChars);
    if (!Number.isSafeInteger(lines) || lines < 1) {
        throw new Error(`PLURNK_SERVICE_PREVIEW_LINES must be a positive safe integer, got ${JSON.stringify(rawLines)}`);
    }
    if (!Number.isSafeInteger(chars) || chars < 1) {
        throw new Error(`PLURNK_SERVICE_PREVIEW_CHARS must be a positive safe integer, got ${JSON.stringify(rawChars)}`);
    }
    return { lines, chars };
};

// PacketSection is the canonical packet shape: an ordered list of named,
// slotted sections (defined below). Sections arrive both from Engine's
// in-memory packet AND from `turns.packet` re-parsed by the digest — re-parsed
// leaf fields are untyped (SectionView), narrowed by the runtime `typeof`
// checks below (boundaries validate). Engine's RequestPacket is strict.
interface ActionTarget {
    kind?: unknown;
    raw?: unknown;
    scheme?: string | null;
    hostname?: string | null;
    port?: number | null;
    pathname?: string | null;
    fragment?: string | null;
}
// The durable statement supplies operand identity and bodies without asking the
// packet mirror to re-serialize the model's complete emission tag.
interface StatementTx {
    target?: ActionTarget | null;
    lineMarker?: unknown;
    body?: string | {
        raw?: unknown;
        target?: ActionTarget | null;
        lineMarker?: unknown;
    } | null;
}
interface RxView {
    content?: unknown;
    mimetype?: unknown;
    startLine?: unknown;
    region?: unknown;
    matches?: unknown;
    itemsTokenTotal?: unknown;
    omittedItems?: unknown;
    receipt?: unknown;
    effects?: unknown;
}
interface LogEntryView {
    coordinate?: unknown;
    op?: unknown;
    origin?: unknown;
    status?: unknown;
    target?: ActionTarget | null;
    tx?: StatementTx | string | null;
    mimetype_tx?: unknown;
    rx?: unknown;
    mimetype_rx?: unknown;
    folded?: boolean;
    source?: unknown;
    attrs?: unknown;
}
interface FailurePointer { status?: unknown; coordinate?: unknown }
interface NoticeView {
    kind?: unknown;
    message?: unknown;
    position?: { type?: unknown; line?: unknown; column?: unknown } | null;
}
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


    // Durable operation failures render as terse pointers to the log rows that
    // own their exact RFC 9457 results.
    static renderFailurePointers(failures: unknown): string {
        const rows = Array.isArray(failures) ? failures as FailurePointer[] : [];
        return rows
            .filter((row) => typeof row.status === "number" && typeof row.coordinate === "string")
            .map((row) => `* ${row.status} log:///${row.coordinate}`)
            .join("\n");
    }

    // Non-terminal model-facing observations are deliberately separate from
    // operation failures. Producer messages are normalized and bounded by the
    // shared preview limit; typed positions remain legible.
    static renderNotices(notices: unknown): string {
        const observations = Array.isArray(notices) ? notices as NoticeView[] : [];
        return observations.map((notice) => {
            const kind = typeof notice.kind === "string" ? notice.kind : "notice";
            const rawMessage = typeof notice.message === "string"
                ? notice.message.replace(/\s+/g, " ").trim()
                : "";
            const message = rawMessage.length > 0
                ? PacketWire.#preview(rawMessage).text
                : "";
            const position = notice.position?.type === "content-offset"
                ? ` @ ${String(notice.position.line)}:${String(notice.position.column)}`
                : "";
            return `* ${kind}${message.length > 0 ? `: ${message}` : ""}${position}`;
        }).join("\n");
    }

    // The Child Streams / Active Child Workers sections ({§child-orientation}) — the OPPOSITE of advice: terse
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

    // The log section's content: the model's curated rows as a fenced `jsonplurnk` array ({§jsonplurnk}).
    // Data only — no prose leads the fence (the log carries rules for no one). Empty log → ""
    // (the section is omitted).
    static renderLog(entries: unknown, countTokens: CountTokens): string {
        const log = Array.isArray(entries) ? (entries as LogEntryView[]) : [];
        if (log.length === 0) return "";
        const items = PacketWire.#renderLogEntries(log, countTokens);
        // The opening fence is DYNAMIC — one backtick longer than the longest run in any body — so a
        // code sample inside a body can never close the block early (CommonMark closes a fence only on
        // a line of ≥ its own length). {§jsonplurnk-dynamic-fence}
        const longestTicks = Math.max(0, ...[...items.matchAll(/`+/g)].map((m) => m[0].length));
        const fence = "`".repeat(Math.max(3, longestTicks + 1));
        return `${fence}jsonplurnk\n[\n${items}\n]\n${fence}`;
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

    // Number each line of body as `<N>:<line>` — a bare `N:` prefix, NO separator whitespace
    // (#564, owner policy pivot): the leading digit prevents column-zero fence collisions and gives
    // the model line refs for free (`READ<42-46>`), while the absence of any separator means a
    // reproduced line has nothing between `N:` and the content to copy — the hard-tab separator used
    // to leak into edit bodies and corrupt indentation. The content's OWN leading whitespace is
    // content, preserved verbatim.
    // Used for READ@200 content; index-preview numbering is the framework's
    // job now (baked into the preview string — see renderHeredoc).
    static #numberLines(body: string, start = 1): string {
        let line = start;
        return body.replace(
            /(^|\r\n|\r|\n)(?=[\s\S])/g,
            (separator) => `${separator}${line++}:`,
        );
    }

    // The single content-body renderer EVERY output-emitting op routes through, so the line-number
    // convention the model orients on can't drift. Every textual body receives
    // the `N:` prefix from `startLine`; matchers consume canonical content before
    // this presentation projection. Empty content produces no body.
    static #renderContentBody(fence: string, content: string, startLine: number | null = 1): string {
        if (content.length === 0) return "";
        // `startLine === null` means the producer already supplied numbered
        // content; re-numbering would duplicate its coordinates.
        const rendered = startLine !== null
            ? PacketWire.#numberLines(content, startLine)
            : content;
        return PacketWire.#wrapHeredocBody(fence, rendered);
    }

    // Tolerant JSON parser for log entries' persisted rx/tx strings. The engine
    // pre-parses application/json mimetypes; malformed stored text is not JSON.
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

    static #receiptMeta(value: unknown): Record<string, string> {
        const receipt: EditReceipt = assertEditReceipt(value);
        return {
            rev: receipt.revision.slice(0, editReceiptRevisionChars()),
            extent: `${receipt.unit} ${receipt.before}->${receipt.after}`,
            change: `-${receipt.effect.removed} +${receipt.effect.inserted}`,
            range: `${receipt.effect.requested} ${receipt.effect.source}->${receipt.effect.result}`,
        };
    }

    // Wrap a body in heredoc fences. Leading `\n` always (separates the
    // opening fence from the first body character — necessary because
    // numbered bodies start with `1:…` which would otherwise collide
    // visually with the `:::FENCE` markers). Trailing `\n` only when the
    // body doesn't already end with one — otherwise you get a doubled
    // newline that renders as a blank line before the closing fence, which
    // reads as "the content has a trailing blank line" when actually it
    // doesn't. The body's own whitespace decides the shape.
    static #wrapHeredocBody(fence: string, body: string): string {
        const sep = body.endsWith("\n") ? "" : "\n";
        return `<<:::${fence}\n${body}${sep}:::${fence}`;
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
        if (scheme === null || scheme === undefined) return encodePathParens(path.replace(/^\//, ""));
        return renderAddress(scheme, path);
    }

    // Render one Log entry → a single bullet line carrying the meta JSON.
    // No body, no fence — every meaningful field is in the JSON. Naming
    // follows the uniform principle: `path` is identity (this log row's
    // own URI), `target` is the URI in the statement's target slot. COPY/MOVE
    // retain their source and destination selections separately from ordered
    // applied `effects`.
    //
    // On error, status >= 400 signals the failure; Problem Details live on
    // this durable row and the next packet's Errors section points here. (Forward:
    // meta will gain tokensBefore/After + linesBefore/After to convey
    // change scope without carrying the body content.)
    //
    // Per-entry render: one meta JSON line plus the row's canonical body.
    // LogBody owns tx/rx storage interpretation; packet projection owns only
    // visibility, previewing, mimetype rendering, and metadata.
    // The log:/// handle the model sees for an entry.
    // ({§open-fold}).
    static #entryPath(coordinate: string | null, op: string | null): string | null {
        if (coordinate === null) return null;
        return op !== null ? `log:///${coordinate}/${op}` : `log:///${coordinate}`;
    }

    // One preview function for every bounded model-facing projection. Lines
    // protect ordinary documents and chars protect a single-line bomb.
    static #preview(text: string): { text: string; cut: boolean } {
        const { lines: maxLines, chars: maxChars } = previewBounds();
        let lineEnd = text.length;
        let newline = -1;
        for (let line = 0; line < maxLines; line++) {
            newline = text.indexOf("\n", newline + 1);
            if (newline === -1) break;
            if (line === maxLines - 1) lineEnd = newline + 1;
        }
        const end = Math.min(text.length, lineEnd, maxChars);
        return { text: text.slice(0, end), cut: end < text.length };
    }

    static #renderLogEntries(entries: LogEntryView[], countTokens: CountTokens): string {
        return entries.map((e) => {
            const meta: Record<string, unknown> = {};
            const coordinate = typeof e.coordinate === "string" ? e.coordinate : null;
            const op = typeof e.op === "string" && e.op.length > 0 ? e.op : null;
            // An executor entry sink is durably journaled as the system EDIT that
            // created the entry. That storage fact is not the model-facing action:
            // the resulting resource is ordinary readable state pushed into its
            // environment. Project it as a folded system READ so the log advertises
            // the available operation instead of implying that the model or another
            // agent authored a mutation. The coordinate still resolves the same
            // underlying row; the typed attrs preserve exact replay/client semantics.
            const materializedEntry = e.origin === "plurnk" && op === "EDIT"
                && e.attrs !== null && typeof e.attrs === "object"
                && (e.attrs as { kind?: unknown }).kind === "entry_materialized";
            const renderedOp = materializedEntry ? "READ" : op;
            const path = PacketWire.#entryPath(coordinate, renderedOp);
            if (path !== null) meta.path = path;
            if (typeof e.origin === "string") meta.origin = e.origin;
            // {§env-delta}: the environment-delta cause (a sibling worker or a scheme),
            // rendered when present; absent means the owning worker itself (self).
            if (typeof e.source === "string" && e.source.length > 0) meta.source = e.source;
            if (renderedOp !== null) meta.op = renderedOp;
            if (typeof e.status === "number") meta.status = e.status;
            const tx = (typeof e.tx === "string" ? PacketWire.#safeParse(e.tx) : e.tx) as StatementTx | null;
            const target = PacketWire.#renderActionTarget(e.target);
            if (op === "COPY" || op === "MOVE") {
                const source = PacketWire.#renderSelection(
                    e.target ?? tx?.target,
                    tx?.lineMarker,
                );
                const destinationBody = tx?.body !== null && typeof tx?.body === "object"
                    ? tx.body
                    : null;
                const destination = PacketWire.#renderSelection(
                    destinationBody?.target,
                    destinationBody?.lineMarker,
                );
                if (source !== null) meta.source = source;
                if (destination !== null) meta.destination = destination;
                if (
                    typeof e.status === "number"
                    && e.status < 400
                    && (source === null || destination === null)
                ) {
                    throw new Error(`A successful ${op} log row must retain both operand selections.`);
                }
            } else {
                if (target !== null) meta.target = target;
            }
            // EXEC's output is a separate stream entry ({§exec-stream}); its address rides in a
            // `stream` link, distinct from `target` (the cwd / executable path it ran in).
            if (op === "EXEC" && e.attrs !== null && typeof e.attrs === "object" && typeof (e.attrs as { stream?: unknown }).stream === "string") {
                meta.stream = (e.attrs as { stream: string }).stream;
            }

            // Parse rx once — reused for the matcher/items enrichment and the body.
            const rx = (typeof e.rx === "string" ? PacketWire.#safeParse(e.rx) : e.rx) as RxView | null;

            // {§log-row-self-explains} - a FAILED op row carries its exact RFC 9457 Problem ON THE META LINE,
            // so the record explains itself in every packet, folded or open. The old shape (a bare
            // status or a lossy error string; the Problem buried in an rx no render shows) sent the wildcard model
            // theorizing "SEND[409] probably means bad request?" for 201s, and the jumbo model
            // chasing a phantom "engine error" off a message-less item. The row IS the model's op
            // result: one standard, pretrained failure object. The Errors section stays a terse pointer.
            if (typeof e.status === "number" && e.status >= 400 && rx !== null && typeof rx === "object") {
                const problem = (rx as { problem?: unknown }).problem;
                Validator.assertProblemDetails(problem as ProblemDetails);
                meta.problem = problem;
            }

            // READ + FIND enrichment: the matcher body, READ match coordinates,
            // and FIND resource count. Match coordinates let the model choose a
            // surgical follow-up READ without silently narrowing this result.
            let items: number | null = null;
            if (op === "READ" || op === "FIND") {
                if (tx !== null && tx !== undefined && typeof tx === "object" && tx.body !== null && typeof tx.body === "object") {
                    if (typeof tx.body.raw === "string") meta.matcher = tx.body.raw;
                }
                if (op === "FIND" && rx !== null && typeof rx === "object" && typeof rx.omittedItems === "number") {
                    items = rx.omittedItems; // {§find-count-not-contents} - selected-resource count, though rows were not enumerated
                } else if (op === "FIND" && rx !== null && typeof rx === "object" && typeof rx.content === "string") {
                    const parsed = PacketWire.#safeParse(rx.content);
                    if (Array.isArray(parsed)) items = parsed.length;
                }
                if (op === "READ" && rx !== null && typeof rx === "object" && rx.matches !== undefined) {
                    meta.matches = SchemeResults.assertMatchEvidenceList(rx.matches);
                }
                if (op === "READ" && rx !== null && typeof rx === "object" && rx.region !== undefined) {
                    meta.region = Validator.assertTextRegion(rx.region as TextRegion);
                }
                // The matched set's content weight (sum of the entries' live channel tokens) — the
                // FIND self-describes its hits' READ-weight; carries the per-scheme roll-up in the foist.
                if (op === "FIND" && rx !== null && typeof rx === "object" && typeof rx.itemsTokenTotal === "number") {
                    meta.itemsTokenTotal = rx.itemsTokenTotal;
                }
            }

            // Mutations expose compact, validated outcome metadata. EDIT owns
            // one receipt; COPY/MOVE own ordered resource effects whose
            // optional receipts describe scoped textual materializations.
            if (op === "EDIT" && rx !== null && typeof rx === "object" && Object.hasOwn(rx, "receipt")) {
                Object.assign(meta, PacketWire.#receiptMeta(rx.receipt));
            }
            if (
                (op === "COPY" || op === "MOVE")
                && rx !== null
                && typeof rx === "object"
                && Object.hasOwn(rx, "effects")
            ) {
                meta.effects = assertResourceEffects(rx.effects).map((effect) => ({
                    target: effect.target,
                    action: effect.action,
                    ...(effect.receipt === undefined
                        ? {}
                        : PacketWire.#receiptMeta(effect.receipt)),
                }));
            }

            // The canonical full body is shared with READ(log://), FIND(log://),
            // and search derivation. Only a worker-issued READ/FIND result renders
            // complete; every pushed, authored, ambient, plugin, and engine body
            // uses this one preview projection.
            const fullBody = LogBody.resolve({
                op: op ?? "",
                tx: e.tx,
                rx: e.rx,
                mimetypeTx: typeof e.mimetype_tx === "string" ? e.mimetype_tx : undefined,
                mimetypeRx: typeof e.mimetype_rx === "string" ? e.mimetype_rx : undefined,
            });
            const emptyFind = op === "FIND" && e.status === 200 && items === 0;
            const previewExempt = e.origin === "model" && (op === "READ" || op === "FIND");
            const projection = previewExempt
                ? { text: fullBody.content, cut: false }
                : PacketWire.#preview(fullBody.content);
            const resourceBody = op === "READ" || op === "FIND" || op === "EDIT"
                || op === "prompt";
            const bodyFence = resourceBody ? (target ?? path) : path;
            if (projection.cut && path === null) {
                throw new Error("a previewed log body requires an addressable log path");
            }
            if (projection.cut) {
                meta.overflow = `Body content truncated. Use READ ${path} to view the full body.`;
            }
            const body = emptyFind || projection.text.length === 0
                ? ""
                : PacketWire.#renderContentBody(
                    bodyFence ?? `log:///${coordinate}`,
                    projection.text,
                    fullBody.startLine,
                );

            // tokens on EVERY row (0 when there's genuinely no body) so the model can always weigh
            // it; for a folded row this is the room an OPEN would add. items present even at 0.
            if (items !== null) meta.items = items;
            // 0 for a genuinely empty body — never call countTokens("") (some providers return
            // undefined for it, which JSON.stringify would drop, leaving the row with no tokens).
            meta.tokens = body.length > 0 ? countTokens(body) : 0;
            // lines beside tokens on any row with a navigable body — the count of `N:`-numbered
            // lines (fences and unnumbered prose don't count), so the model can plan a <start,end>
            // slice before paying for an OPEN. Omitted when the body isn't line-addressable.
            if (body.length > 0) {
                const navigable = body.split("\n").filter((l) => /^\d+:/.test(l)).length;
                if (navigable > 0) meta.lines = navigable;
            }

            // {§jsonplurnk} — `display` describes the three body states: `none` carries an explicit
            // empty JSON string, `folded` withholds an existing body, and `open` appends that body as
            // the format's one non-JSON value (a raw, tagged heredoc). The explicit empty body keeps
            // every state self-describing; OPEN/FOLD remain friendly no-ops on `none`.
            const display = body.length === 0 ? "none" : e.folded === true ? "folded" : "open";
            meta.display = display;
            if (display === "none") meta.body = "";
            const obj = PacketWire.#canonicalJson(meta);
            return display === "open" ? obj.replace(/\}$/, `,"body":\n${body}\n}`) : obj;
        }).join(",\n");
    }

    static #renderActionTarget(target: ActionTarget | null | undefined): string | null {
        if (target === null || target === undefined) return null;
        // An authority-bearing target (worker://<name> — the worker IS the authority, {§worker-scheme};
        // a web host http://host/path) keeps its name in `hostname`. Without it a spawn renders
        // as a bare `worker://`, indistinguishable across workers — the model goes blind to what it
        // spawned and re-spawns. Reconstruct the authority form when a hostname is present;
        // namespace schemes (plurnk/known) fold their authority into the path and fall through.
        const host = typeof target.hostname === "string" && target.hostname.length > 0 ? target.hostname : null;
        const rendered = host !== null && typeof target.scheme === "string" && target.scheme.length > 0
            ? `${target.scheme}://${host}${target.port ? `:${target.port}` : ""}${encodePathParens(target.pathname ?? "")}`
            : PacketWire.#renderModelUri(target.scheme, target.pathname);
        if (rendered.length === 0) return null;
        // The channel fragment (#stdout/#stderr) is part of the address — a stream delta has to
        // say WHICH channel it is, not just the entry. {§exec-stream}
        const fragment = typeof target.fragment === "string" && target.fragment.length > 0 ? `#${target.fragment}` : "";
        return rendered + fragment;
    }

    static #renderSelection(
        target: ActionTarget | null | undefined,
        marker: unknown,
    ): string | null {
        if (target === null || target === undefined) return null;
        const address = target.kind === "local" && typeof target.raw === "string"
            ? target.raw
            : target.scheme === "file"
                ? encodePathParens(target.pathname?.replace(/^\//, "") ?? "")
                : PacketWire.#renderActionTarget(target);
        if (address === null || address.length === 0) return null;
        if (marker === null || marker === undefined) return address;
        const validation = Validator.validateLineMarker(marker);
        if (!validation.valid) {
            throw new TypeError("A COPY/MOVE operand contains an invalid line marker.");
        }
        return `${address}<${(marker as LineMarker).marks.join(",")}>`;
    }

    static #renderGitState(git: GitStatus): string {
        const sync = git.ahead > 0 || git.behind > 0 ? ` (↑${git.ahead} ↓${git.behind})` : "";
        return `branch \`${git.branch}\`${sync} — ${git.staged} staged, ${git.unstaged} unstaged, ${git.untracked} untracked`;
    }

}
