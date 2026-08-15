// Packet → wire markdown projection. Single source of truth for how the
// Packet's ordered list of sections renders to ChatMessage.content
// strings the LLM receives. Engine imports this for the wire payload; the
// digest tool imports it to write byte-identical packetNNN.{system,user}.md
// files. No second implementation, no drift.
//
// Format and omission rules are owned by {§packet-markdown}. Section producers
// supply names and typed content; this projection preserves their ordered evidence.

import { Validator, type ProblemDetails, type RangeExtent, type TextLineMarker, type TextRegion } from "@plurnk/plurnk-contracts";
import { TextCoordinates, type TextLine } from "@plurnk/plurnk-mimetypes";
import { renderTarget } from "./plurnk-uri.ts";
import type { GitStatus } from "./git-state.ts";
import LogBody from "./LogBody.ts";
import LogEntryProjection from "./LogEntryProjection.ts";
import {
    assertEditReceipt,
    assertResourceEffects,
    LineAnchors,
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

// {§packet-stored-shape} — sections arrive from both the in-memory request and
// the durable packet re-parsed by the digest. The latter uses the loose view
// below and is narrowed at the rendering boundary.
interface ActionTarget {
    kind?: unknown;
    raw?: unknown;
    scheme?: string | null;
    hostname?: string | null;
    port?: number | null;
    pathname?: string | null;
    query?: string | null;
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
    itemsTokenTotal?: unknown;
    returnedItemsTokenTotal?: unknown;
    matchLocationCount?: unknown;
    range?: unknown;
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
    tags?: unknown;
    lineAnchors?: readonly string[];
}
interface FailurePointer { status?: unknown; coordinate?: unknown }
interface NoticeView {
    kind?: unknown;
    message?: unknown;
    position?: { type?: unknown; line?: unknown; column?: unknown } | null;
}
// Loose view of a section re-parsed from `turns.packet` JSON (the digest path).
interface SectionView { name?: unknown; slot?: unknown; header?: unknown; content?: unknown; tokens?: unknown }
interface Packet { sections?: SectionView[] }
type CountTokens = (text: string) => number;
interface RenderLogOptions {
    readonly promptProjectionBudget?: number;
}

export default class PacketWire {
    // {§packet-markdown} Render the sections in `slot` to one ChatMessage.content
    // string. Sections render in list order; empties are omitted (no empty headers on the wire);
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
    static renderGit(git: unknown, assignedBranch: string | null = null): string {
        const status = git === null || git === undefined ? "" : PacketWire.#renderGitState(git as GitStatus);
        const assignment = assignedBranch === null
            ? ""
            : `assigned branch \`${assignedBranch}\` — commit any project changes and leave the checkout clean before concluding`;
        return [status, assignment].filter((line) => line.length > 0).join("\n");
    }

    // The log section's content: the model's curated rows as a fenced `jsonplurnk` array ({§jsonplurnk}).
    // Data only — no prose leads the fence (the log carries rules for no one). Empty log → ""
    // (the section is omitted).
    static renderLog(entries: unknown, countTokens: CountTokens, options: RenderLogOptions = {}): string {
        const log = Array.isArray(entries) ? (entries as LogEntryView[]) : [];
        if (log.length === 0) return "";
        const items = PacketWire.#renderLogEntries(log, countTokens, options);
        // Every source line is coordinate-prefixed, so source backticks never occupy the
        // CommonMark closing-fence position. The fixed opener keeps the packet prefix cache-stable.
        return `\`\`\`jsonplurnk\n[\n${items}\n]\n\`\`\``;
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

    // Number a non-READ body line as `<N>:<line>` — a bare `N:` prefix, NO separator whitespace
    // ({§render-rule-line-navigable-prefix}): the leading digit prevents column-zero fence collisions and gives
    // the model line refs for free (`## READ0 (...) <42-46>`), while the absence of any separator means a
    // reproduced line has nothing between `N:` and the content to copy — the hard-tab separator used
    // to leak into edit bodies and corrupt indentation. The content's OWN leading whitespace is
    // content, preserved verbatim.
    // Used for READ@200 content; index-preview numbering is the framework's
    // job now (baked into the preview string).
    static #numberLines(body: string, start = 1): string {
        let line = start;
        return `${line++}:${body.replace(
            /(\r\n|\r(?!\n)|\n)(?=[\s\S])/g,
            (separator) => `${separator}${line++}:`,
        )}`;
    }

    // The single content-body renderer EVERY output-emitting op routes through.
    // Exact READ content receives `@hash N:`; other textual bodies receive `N:`.
    // Matchers consume canonical content before this presentation projection.
    // Empty content produces no body.
    static #renderContentBody(
        content: string,
        startLine: number | null = 1,
        lineAnchors: readonly string[] | null = null,
    ): string {
        if (content.length === 0) return "";
        // `startLine === null` means the producer already supplied numbered
        // content; re-numbering would duplicate its coordinates.
        const rendered = startLine !== null
            ? lineAnchors === null
                ? PacketWire.#numberLines(content, startLine)
                : LineAnchors.render(content, startLine, lineAnchors)
            : content;
        return PacketWire.#quoteBody(rendered);
    }

    // Tolerant JSON parser for log entries' persisted rx/tx strings. The engine
    // pre-parses application/json mimetypes; malformed stored text is not JSON.
    static #safeParse(s: string): unknown {
        try { return JSON.parse(s); } catch { return null; }
    }

    // Stable JSON: keys sorted alphabetically so the same meta produces the
    // same string across turns — prefix-cache friendly.
    static #canonicalJson(obj: Record<string, unknown>): string {
        const keys = Object.keys(obj).sort();
        const sorted: Record<string, unknown> = {};
        for (const k of keys) sorted[k] = obj[k];
        return JSON.stringify(sorted);
    }

    static #receiptMeta(value: unknown): Record<string, string> {
        const receipt: EditReceipt = assertEditReceipt(value);
        const head = {
            rev: receipt.revision.slice(0, editReceiptRevisionChars()),
            extent: `${receipt.unit} ${receipt.before}->${receipt.after}`,
        };
        if ("effect" in receipt) {
            return {
                ...head,
                change: `-${receipt.effect.removed} +${receipt.effect.inserted}`,
                range: `${receipt.effect.requested} ${receipt.effect.source}->${receipt.effect.result}`,
            };
        }
        return {
            ...head,
            disposition: receipt.disposition,
            requested: receipt.requested,
            ...(receipt.replacement === undefined
                ? {}
                : {
                    change: `-${receipt.replacement.removed} +${receipt.replacement.inserted}`,
                    replacement: `${receipt.replacement.requested} ${receipt.replacement.source}->${receipt.replacement.result}`,
                }),
        };
    }

    // {§jsonplurnk} One deliberately raw multiline JSON string. The physical
    // newline after the opening quote and every positive numeric or anchored coordinate prefix
    // make the closing quote at column zero unambiguous without an invented
    // delimiter for source text to imitate. Already-numbered producer output is
    // checked here too: malformed bodies fail at the one projection boundary.
    static #quoteBody(body: string): string {
        const endsWithLineBreak = /(?:\r\n|\r|\n)$/.test(body);
        const lines = body.split(/\r\n|\r|\n/);
        const contentLines = endsWithLineBreak ? lines.slice(0, -1) : lines;
        if (contentLines.length === 0 || contentLines.some((line) =>
            !/^[1-9]\d*:/.test(line) && !LineAnchors.isAnchoredLine(line))) {
            throw new TypeError("A raw jsonplurnk body requires a positive coordinate prefix on every physical line.");
        }
        return `"\n${body}${endsWithLineBreak ? "" : "\n"}"`;
    }

    // Render one Log entry → a single bullet line carrying the meta JSON.
    // No body, no fence — every meaningful field is in the JSON. Naming
    // follows the uniform principle: `path` is identity (this log row's
    // own URI), `target` is the URI in the statement's target slot. COPY/MOVE
    // retain their source and destination selections separately from ordered
    // applied `effects`.
    //
    // On error, status >= 400 signals the failure; Problem Details live on
    // this durable row and the next packet's Errors section points here.
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

    static #offsetAfterCharacters(text: string, count: number): number {
        let offset = 0;
        let consumed = 0;
        while (offset < text.length && consumed < count) {
            if (text.startsWith("\r\n", offset)) {
                offset += 2;
            } else {
                const codePoint = text.codePointAt(offset);
                if (codePoint === undefined) break;
                offset += String.fromCodePoint(codePoint).length;
            }
            consumed++;
        }
        return offset;
    }

    // One preview function for every bounded model-facing projection. Lines
    // protect ordinary documents and Unicode characters protect a single-line
    // bomb. Once a physical line is complete, a character cut retreats to that
    // line boundary rather than exposing a partial coordinate prefix.
    static #preview(text: string): { text: string; cut: boolean; chunk: string | null } {
        const { lines: maxLines, chars: maxChars } = previewBounds();
        const coordinates = new TextCoordinates(text);
        const physicalLines = coordinates.logicalLines();
        const lineEnd = physicalLines.length > maxLines
            ? physicalLines[maxLines - 1]!.end
            : text.length;
        const characterEnd = PacketWire.#offsetAfterCharacters(text, maxChars);
        let end = Math.min(lineEnd, characterEnd);
        if (characterEnd < text.length && characterEnd <= lineEnd) {
            const completeLine = physicalLines.findLast((line) =>
                line.separator.length > 0 && line.end <= characterEnd);
            if (completeLine !== undefined) end = completeLine.end;
        }
        const cut = end < text.length;
        return {
            text: text.slice(0, end),
            cut,
            chunk: cut ? PacketWire.#chunk(coordinates, physicalLines, end, text.length) : null,
        };
    }

    static #formatRegion(region: TextRegion): string {
        return `<${region.startLine},${region.startColumn},${region.endLine},${region.endColumn}>`;
    }

    static #chunk(
        coordinates: TextCoordinates,
        lines: readonly TextLine[],
        end: number,
        completeEnd: number,
    ): string {
        const finalCompleteLine = lines.findIndex((line) =>
            line.separator.length > 0 && line.end === end);
        if (finalCompleteLine !== -1) {
            const selected = `<1,${finalCompleteLine + 1}>`;
            const complete = `<1,${lines.length}>`;
            if (selected === complete) {
                throw new Error("a bounded body chunk must differ from its complete line extent");
            }
            return `READing ${selected} of ${complete}`;
        }

        const selectedRegion = coordinates.regionFromOffsets(0, end);
        const completeRegion = coordinates.regionFromOffsets(0, completeEnd);
        if (selectedRegion === null || completeRegion === null) {
            throw new Error("a character-bound body chunk must resolve to exact text coordinates");
        }
        const selected = PacketWire.#formatRegion(selectedRegion);
        const complete = PacketWire.#formatRegion(completeRegion);
        if (selected === complete) {
            throw new Error("a bounded body chunk must differ from its complete text extent");
        }
        return `READing ${selected} of ${complete}`;
    }

    static #promptProjection(
        body: ReturnType<typeof LogBody.resolve>,
        budget: number,
        countTokens: CountTokens,
    ): { text: string; cut: boolean; chunk: string | null } {
        const weightAt = (end: number): number => countTokens(
            PacketWire.#renderContentBody(body.content.slice(0, end), body.startLine, null),
        );
        if (weightAt(body.content.length) <= budget) {
            return { text: body.content, cut: false, chunk: null };
        }
        if (budget <= 0) return { text: "", cut: true, chunk: null };

        const coordinates = new TextCoordinates(body.content);
        const lines = coordinates.logicalLines();
        const completeLineEnds = lines
            .filter((line) => line.separator.length > 0 && line.end < body.content.length)
            .map((line) => line.end);
        let low = 0;
        let high = completeLineEnds.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (weightAt(completeLineEnds[middle]!) <= budget) low = middle + 1;
            else high = middle;
        }
        const completeLineEnd = low === 0 ? 0 : completeLineEnds[low - 1]!;
        if (completeLineEnd > 0) {
            return {
                text: body.content.slice(0, completeLineEnd),
                cut: true,
                chunk: PacketWire.#chunk(coordinates, lines, completeLineEnd, body.content.length),
            };
        }

        const firstLineEnd = lines[0]?.contentEnd ?? body.content.length;
        const offsets = [0];
        let offset = 0;
        for (const codePoint of body.content.slice(0, firstLineEnd)) {
            offset += codePoint.length;
            offsets.push(offset);
        }
        low = 0;
        high = offsets.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (weightAt(offsets[middle]!) <= budget) low = middle + 1;
            else high = middle;
        }
        const characterEnd = low === 0 ? 0 : offsets[low - 1]!;
        if (characterEnd === 0) return { text: "", cut: true, chunk: null };
        return {
            text: body.content.slice(0, characterEnd),
            cut: true,
            chunk: PacketWire.#chunk(coordinates, lines, characterEnd, body.content.length),
        };
    }

    static #promptBudgets(
        entries: readonly LogEntryView[],
        bodies: readonly ReturnType<typeof LogBody.resolve>[],
        countTokens: CountTokens,
        budget: number | undefined,
    ): ReadonlyMap<number, number> {
        if (budget === undefined) return new Map();
        if (!Number.isSafeInteger(budget) || budget < 0) {
            throw new RangeError(`promptProjectionBudget must be a non-negative safe integer, got ${JSON.stringify(budget)}`);
        }
        const costs = entries.flatMap((entry, index) => {
            if (entry.op !== "prompt" || entry.folded === true || bodies[index]!.content.length === 0) return [];
            const rendered = PacketWire.#renderContentBody(bodies[index]!.content, bodies[index]!.startLine, null);
            return [{ index, cost: countTokens(rendered) }];
        });
        const allocations = new Map<number, number>();
        let remaining = budget;
        let active = costs;
        while (active.length > 0) {
            const share = Math.floor(remaining / active.length);
            const complete = active.filter(({ cost }) => cost <= share);
            if (complete.length === 0) {
                const extra = remaining % active.length;
                active.forEach(({ index }, position) => allocations.set(index, share + (position < extra ? 1 : 0)));
                break;
            }
            for (const { index, cost } of complete) {
                allocations.set(index, cost);
                remaining -= cost;
            }
            const completed = new Set(complete.map(({ index }) => index));
            active = active.filter(({ index }) => !completed.has(index));
        }
        return allocations;
    }

    static #renderLogEntries(entries: LogEntryView[], countTokens: CountTokens, options: RenderLogOptions): string {
        const bodies = entries.map((e) => {
            const op = typeof e.op === "string" && e.op.length > 0 ? e.op : null;
            return LogBody.resolve({
                op,
                attrs: e.attrs,
                tx: e.tx,
                rx: e.rx,
                mimetypeTx: typeof e.mimetype_tx === "string" ? e.mimetype_tx : undefined,
                mimetypeRx: typeof e.mimetype_rx === "string" ? e.mimetype_rx : undefined,
            });
        });
        const promptBudgets = PacketWire.#promptBudgets(
            entries,
            bodies,
            countTokens,
            options.promptProjectionBudget,
        );
        return entries.map((e, index) => {
            const meta: Record<string, unknown> = {};
            const coordinate = typeof e.coordinate === "string" ? e.coordinate : null;
            const op = typeof e.op === "string" && e.op.length > 0 ? e.op : null;
            const renderedOp = LogEntryProjection.op(e);
            const actionlessKind = op === null
                ? LogBody.actionlessKind({ op, attrs: e.attrs })
                : null;
            const path = PacketWire.#entryPath(coordinate, renderedOp);
            if (path !== null) meta.path = path;
            if (typeof e.origin === "string") meta.origin = e.origin;
            // {§env-delta-attribution}: render the causal worker address or
            // subsystem token when present; absence means the owning worker.
            if (typeof e.source === "string" && e.source.length > 0) meta.source = e.source;
            if (actionlessKind !== null) meta.kind = actionlessKind;
            if (e.source === "file" && e.attrs !== null && typeof e.attrs === "object" && "git" in e.attrs) {
                const git = (e.attrs as { git?: unknown }).git;
                if (typeof git !== "string" || git.length !== 2) {
                    throw new TypeError("A source=file log row carries malformed Git XY metadata.");
                }
                meta.git = git;
            }
            if (typeof e.status === "number") meta.status = e.status;
            if (e.tags !== undefined) {
                const storedTags = e.tags;
                if (!Array.isArray(storedTags) || !storedTags.every((tag) => typeof tag === "string" && tag.length > 0)) {
                    throw new TypeError("A log row carries malformed folksonomic tags.");
                }
                const tags = [...new Set(storedTags)].toSorted();
                if (tags.length !== storedTags.length || tags.some((tag, index) => tag !== storedTags[index])) {
                    throw new TypeError("A log row's folksonomic tags must be unique and sorted.");
                }
                if (tags.length > 0) meta.tags = tags;
            }
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
            // `stream` link, distinct from the runtime-owned invocation target.
            if (op === "EXEC" && e.attrs !== null && typeof e.attrs === "object" && typeof (e.attrs as { stream?: unknown }).stream === "string") {
                meta.stream = (e.attrs as { stream: string }).stream;
            }

            // Parse rx once — reused for the matcher/items enrichment and the body.
            const rx = (typeof e.rx === "string" ? PacketWire.#safeParse(e.rx) : e.rx) as RxView | null;

            // {§log-row-self-explains} — a failed operation projects its exact
            // Problem on the row meta line; Errors remains only an index.
            if (typeof e.status === "number" && e.status >= 400 && rx !== null && typeof rx === "object") {
                const problem = (rx as { problem?: unknown }).problem;
                Validator.assertProblemDetails(problem as ProblemDetails);
                meta.problem = problem;
            }

            // {§retrieval-packet-metadata}: one extent/coordinate owner plus
            // only FIND aggregates that add information beyond that extent.
            let findItems: number | null = null;
            if (op === "READ" || op === "FIND") {
                const findMatcher = op === "FIND"
                    && tx !== null
                    && tx !== undefined
                    && typeof tx === "object"
                    && tx.body !== null
                    && typeof tx.body === "object";
                if (findMatcher) {
                    const body = tx?.body;
                    if (body !== null && typeof body === "object" && typeof body.raw === "string") {
                        meta.matcher = body.raw;
                    }
                }
                if (op === "FIND" && rx !== null && typeof rx === "object" && typeof rx.content === "string") {
                    const parsed = PacketWire.#safeParse(rx.content);
                    if (Array.isArray(parsed)) findItems = parsed.length;
                }
                const range = rx !== null && typeof rx === "object" && rx.range !== undefined
                    ? rx.range
                    : undefined;
                const problemOwnsRange = typeof e.status === "number"
                    && e.status >= 400
                    && meta.problem !== null
                    && typeof meta.problem === "object"
                    && Object.hasOwn(meta.problem, "range");
                if (problemOwnsRange) {
                    Validator.assertRangeExtent((meta.problem as { range: RangeExtent }).range);
                }
                if (range !== undefined && !problemOwnsRange) {
                    meta.range = Validator.assertRangeExtent(range as RangeExtent);
                } else if (op === "READ" && rx !== null && typeof rx === "object" && rx.region !== undefined) {
                    meta.region = Validator.assertTextRegion(rx.region as TextRegion);
                }
                // These are underlying selected-content weights, distinct from
                // the emitted body's generic `tokens` measurement.
                if (op === "FIND" && rx !== null && typeof rx === "object" && typeof rx.itemsTokenTotal === "number" && rx.itemsTokenTotal > 0) {
                    meta.itemsTokenTotal = rx.itemsTokenTotal;
                }
                if (
                    op === "FIND"
                    && rx !== null
                    && typeof rx === "object"
                    && typeof rx.returnedItemsTokenTotal === "number"
                    && rx.returnedItemsTokenTotal > 0
                    && rx.returnedItemsTokenTotal !== rx.itemsTokenTotal
                ) {
                    meta.returnedItemsTokenTotal = rx.returnedItemsTokenTotal;
                }
                if (
                    findMatcher
                    && range !== null
                    && typeof range === "object"
                    && (range as { unit?: unknown }).unit === "resource"
                    && rx !== null
                    && typeof rx === "object"
                    && typeof rx.matchLocationCount === "number"
                    && rx.matchLocationCount > 0
                ) {
                    meta.matchLocationCount = rx.matchLocationCount;
                }
            }

            // {§edit-result-receipt-projection} {§edit-result-copy-move-effects}
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

            // The canonical full body is shared with log READ, log FIND,
            // and search derivation. READ/FIND own selection bounds, PLAN is
            // persistent working memory, and prompt rows share their packet
            // allowance; every remaining body uses the ordinary fixed preview.
            const fullBody = bodies[index]!;
            const emptyFind = op === "FIND" && e.status === 200 && findItems === 0;
            const previewExempt = op === "READ" || op === "FIND" || op === "PLAN";
            const promptBudget = promptBudgets.get(index);
            const projection = promptBudget !== undefined
                ? PacketWire.#promptProjection(fullBody, promptBudget, countTokens)
                : previewExempt
                ? { text: fullBody.content, cut: false, chunk: null }
                : PacketWire.#preview(fullBody.content);
            if (projection.cut && path === null) {
                throw new Error("a previewed log body requires an addressable log path");
            }
            const lineAnchors = op === "READ" ? e.lineAnchors ?? null : null;
            const body = emptyFind || projection.text.length === 0
                ? ""
                : PacketWire.#renderContentBody(projection.text, fullBody.startLine, lineAnchors);

            // tokens on EVERY row (0 when there's genuinely no body) so the model can always weigh
            // it; for a folded row this is the room an OPEN would add.
            // 0 for a genuinely empty body — never call countTokens("") (some providers return
            // undefined for it, which JSON.stringify would drop, leaving the row with no tokens).
            meta.tokens = body.length > 0 ? countTokens(body) : 0;
            // lines beside tokens on a non-retrieval row with a navigable body — the count of
            // `N:`-numbered lines (fences and unnumbered prose don't count), so the model can plan
            // a <start,end> slice before paying for an OPEN. READ/FIND own typed extents instead.
            if (body.length > 0 && op !== "READ" && op !== "FIND") {
                const navigable = body.split("\n").filter((l) => /^\d+:/.test(l)).length;
                if (navigable > 0) meta.lines = navigable;
            }

            // {§jsonplurnk} — `display` describes the three body states: `none` carries an explicit
            // empty JSON string, `folded` withholds an existing body, and `open` appends that body as
            // the format's one raw multiline string. The explicit empty body keeps
            // every state self-describing; OPEN/FOLD remain friendly no-ops on `none`.
            const display = body.length === 0 ? "none" : e.folded === true ? "folded" : "open";
            meta.display = display;
            if (display === "none") meta.body = "";
            const obj = PacketWire.#canonicalJson(meta);
            if (display !== "open") return obj;
            const chunk = projection.chunk !== null
                ? `,"chunk":${JSON.stringify(projection.chunk)}`
                : "";
            return obj.replace(/\}$/, `,"body":${body}${chunk}}`);
        }).join(",\n");
    }

    static #renderActionTarget(target: ActionTarget | null | undefined): string | null {
        if (target === null || target === undefined) return null;
        return renderTarget({
            scheme: target.scheme,
            hostname: target.hostname,
            port: target.port,
            pathname: target.pathname,
            query: target.query,
            fragment: target.fragment,
        });
    }

    static #renderSelection(
        target: ActionTarget | null | undefined,
        marker: unknown,
    ): string | null {
        if (target === null || target === undefined) return null;
        const address = target.kind === "local" && typeof target.raw === "string"
            ? renderTarget({ scheme: null, pathname: target.raw })
            : target.scheme === "file"
                ? renderTarget({ scheme: null, pathname: target.pathname ?? "" })
                : PacketWire.#renderActionTarget(target);
        if (address === null || address.length === 0) return null;
        if (marker === null || marker === undefined) return address;
        const validation = Validator.validateTextLineMarker(marker);
        if (!validation.valid) {
            throw new TypeError("A COPY/MOVE operand contains an invalid text line marker.");
        }
        return `${address}<${(marker as TextLineMarker).marks.join(",")}>`;
    }

    static #renderGitState(git: GitStatus): string {
        const sync = git.ahead > 0 || git.behind > 0 ? ` (↑${git.ahead} ↓${git.behind})` : "";
        return `branch \`${git.branch}\`${sync} — ${git.staged} staged, ${git.unstaged} unstaged, ${git.untracked} untracked`;
    }

}
