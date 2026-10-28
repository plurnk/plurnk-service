import { relative, sep } from "node:path";
import { Problems, Validator, isExecutionOp, isRecord, isSafeInteger, type ParsedPath, type RangeExtent } from "@plurnk/plurnk-contracts";
import { Results as SchemeResults, type MatchEvidence } from "@plurnk/plurnk-schemes";
import { assertEditReceipt, assertResourceEffects, type EditReceipt } from "../content/index.ts";
import ScopeFormat from "../content/scope-format.ts";
import { renderAuthoredTarget, renderTarget } from "./plurnk-uri.ts";
import type { ResolvedLogBody } from "./LogBody.ts";
import LogEntryProjection from "./LogEntryProjection.ts";
import type { LogEntryView, RenderLogOptions } from "./packet-wire.ts";

// {§packet} — sections arrive from both the in-memory request and
// the durable packet re-parsed by the digest. The latter uses the loose view
// below and is narrowed at the rendering boundary.
export interface ActionTarget {
    kind?: unknown;
    raw?: unknown;
    scheme?: string | null;
    hostname?: string | null;
    port?: number | null;
    pathname?: string | null;
    query?: string | null;
    fragment?: string | null;
    username?: string | null;
    password?: string | null;
}

// The durable statement supplies operand identity and bodies without asking the packet mirror to re-serialize the
// model's complete emission tag. Parsed from its stored column, it is a record whose fields are proved where read.
export type StatementTx = Readonly<Record<string, unknown>>;
// A stored result, parsed: a record whose fields are proved where read.
export type RxView = Readonly<Record<string, unknown>>;

// One log row through the four stages of its rendering: identity, result facts, body, accounting.
export interface RowIdentity {
    readonly meta: Record<string, unknown>;
    readonly op: string | null;
    readonly tx: StatementTx | null;
    readonly coordinate: string | null;
    readonly path: string;
    readonly renderedLeaf: string;
    readonly target: string | null;
    readonly description: string | null;
}

export interface RowResultFacts {
    readonly matches?: readonly MatchEvidence[];
    readonly findItems: number | null;
    readonly range: RangeExtent | null;
    readonly structuredMutationReceipt: boolean;
}

export default class PacketRowFacts {
    // Tolerant JSON parser for log entries' persisted rx/tx strings. The engine
    // pre-parses application/json mimetypes; malformed stored text is not JSON.
    static safeParse(s: string): unknown {
        try { return JSON.parse(s); } catch { return null; }
    }

    static attrsOf(e: { readonly attrs?: unknown }): Record<string, unknown> {
        const attrs = typeof e.attrs === "string" ? PacketRowFacts.safeParse(e.attrs) : e.attrs;
        return isRecord(attrs) ? attrs : {};
    }

    // {§message-arrival} — an inbound SEND row: harness-published, the sender's statement as its
    // sent side. {§message-arrival}: a `source` names the actor; absence is the owner.
    static isArrival(e: { readonly op?: unknown; readonly origin?: unknown; readonly attrs?: unknown }): boolean {
        if (e.op !== "SEND" || e.origin !== "_plurnk") return false;
        const attrs: unknown = typeof e.attrs === "string" ? JSON.parse(e.attrs) : e.attrs;
        return isRecord(attrs) && attrs.kind === "message";
    }

    // {§log-wire-format} — row identity belongs to the H3, not its operand metadata.
    static #entryPath(coordinate: string | null, leaf: string): string {
        if (coordinate === null) throw new TypeError("A packet log row requires an addressable coordinate.");
        return `log:///${coordinate}/${leaf}`;
    }

    // The row's identity and authored facts: who wrote it, what it addressed, and the statuses
    // that stay explicit. `meta` is the metadata line under construction; each later stage adds
    // to it, and {§log-wire-format}'s canonical JSON sorts the keys, so the order of stages never
    // reaches the wire.
    static rowIdentity(e: LogEntryView, options: RenderLogOptions): RowIdentity {
        const meta: Record<string, unknown> = {};
        const coordinate = typeof e.coordinate === "string" ? e.coordinate : null;
        const op = typeof e.op === "string" && e.op.length > 0 ? e.op : null;
        const renderedLeaf = LogEntryProjection.leaf(e);
        const path = PacketRowFacts.#entryPath(coordinate, renderedLeaf);
        // Absence = "model" — the session's own authorship is the default (#338). An arrival is an
        // inbound SEND row the harness published ({§message-arrival}): its stored origin says
        // nothing, so the row names its sender instead (#706).
        // {§turn-source-resources}: an emission row is stored as the harness's, but names its author.
        const author = LogEntryProjection.isEmission(e) ? e.producer : e.origin;
        if (typeof author === "string" && author !== "model" && !PacketRowFacts.isArrival(e)) meta.origin = author;
        // {§env-delta}: render the causal session address or
        // subsystem token when present; absence means the owning session.
        // {§message-arrival} an arrival whose source is the transport's own name for it adds
        // nothing to its address; a peer's or an agent's source still shows.
        const attrs = PacketRowFacts.attrsOf(e);
        const selfAddressed = attrs.selfAddressed === true;
        if (typeof e.source === "string" && e.source.length > 0 && !selfAddressed) meta.source = e.source;
        // {§message-arrival}: every other sender has an address; the operator's message is named
        // for the model, or it reads as the model's own SEND.
        if (PacketRowFacts.isArrival(e) && meta.source === undefined) meta.origin = "user";
        if (e.source === "file" && Object.hasOwn(attrs, "git")) {
            const git = attrs.git;
            if (typeof git !== "string" || git.length !== 2) {
                throw new TypeError("A source=file log row carries malformed Git XY metadata.");
            }
            meta.git = git;
        }
        // {§log-wire-format}: routine success is implicit, independently of the operation.
        if (typeof e.status === "number" && e.status !== 200) meta.status = e.status;
        const parsedTx = typeof e.tx === "string" ? PacketRowFacts.safeParse(e.tx) : e.tx;
        const tx: StatementTx | null = isRecord(parsedTx) ? parsedTx : null;
        const replay = options.paired?.get(String(e.coordinate));
        const paired = replay !== undefined;
        if (!paired && typeof tx?.aside === "string") meta.aside = tx.aside;
        const authored = PacketRowFacts.#authoredPath(tx?.target);
        const target = PacketRowFacts.#operandPath(e.target ?? PacketRowFacts.#actionTarget(tx?.target), options.projectRoot ?? null, authored);
        const pair = op === "COPY" || op === "MOVE";
        const selections: Array<StatementTx | null> = pair
            ? [PacketRowFacts.#selection(tx?.source), PacketRowFacts.#selection(tx?.destination)]
            : [{ ...tx, target: e.target ?? tx?.target }];
        const paths = selections.map((selection) => PacketRowFacts.#operandPath(PacketRowFacts.#actionTarget(selection?.target), options.projectRoot ?? null, authored));
        if (pair && typeof e.status === "number" && e.status < 400 && paths.some((candidate) => candidate === null)) {
            throw new Error(`A successful ${op} log row must retain both operand selections.`);
        }
        for (const field of ["scope", "metadata"] as const) {
            if (paired) continue;
            const values = selections.map((selection) => field === "scope"
                ? PacketRowFacts.#requestScope(selection?.lineMarker)
                : PacketRowFacts.#metadata(selection?.metadata));
            if (pair) {
                const pairedValues = Object.fromEntries(values.flatMap((value, index) => value === null ? [] : [[index === 0 ? "from" : "to", value]]));
                if (Object.keys(pairedValues).length > 0) meta[field] = pairedValues;
            } else if (values[0] !== null) meta[field] = values[0];
        }
        // {§log-wire-format}: describe resources and patterns directly; never serialize an OP.
        const parts = selections.flatMap((selection, index) => {
            const matcher = selection?.matcher;
            const pattern = isRecord(matcher) ? matcher.raw : undefined;
            return [
                ...(paths[index] === null ? [] : [`(${paths[index]})`]),
                ...(typeof pattern !== "string" || pattern.length === 0 ? []
                    : [/[\r\n]/u.test(pattern) ? JSON.stringify(pattern) : pattern]),
            ];
        });
        // {§emission-history}: every receipt names its operand; a paired one leaves its pattern to the replayed operation.
        const operands = paths.filter((candidate) => candidate !== null).map((candidate) => `(${candidate})`).join(" ");
        const description = op === "error" || op === "extension" || parts.length === 0 ? null
            : !paired ? parts.join(" ") : operands.length > 0 ? operands : null;
        // {§execution-output-identity} The created identity is an outcome, not an authored target.
        if ((op === "WORK" || op === "FORK") && typeof attrs.session === "string") {
            meta.session = attrs.session;
            // {§session-scheme} — a WORK that reached a session the name already held says so.
            if (attrs.delivered === "message") meta.delivered = "message";
        }
        // {§session-wait-timing} — the accepted bound, not elapsed time or the current configuration.
        if (op === "WAIT" && Object.hasOwn(attrs, "waiting")) {
            const seconds = attrs.waiting;
            if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
                throw new TypeError("A WAIT receipt carries a malformed waiting bound.");
            }
            meta.waitSeconds = seconds;
        }
        // An execution's output is a separate stream entry ({§exec-stream}); its address rides in a
        // `stream` link, distinct from the runtime-owned invocation target.
        // {§exec-target-routing} {§fs-namespace} — the receipt names the working directory only
        // when it is not the project root, and then in project-relative form.
        if (isExecutionOp(op) && typeof attrs.cwd === "string") {
            const cwd = PacketRowFacts.#projectRelativeCwd(attrs.cwd, options.projectRoot ?? null);
            if (cwd !== null) meta.cwd = cwd;
        }
        if (isExecutionOp(op) && typeof attrs.stream === "string") {
            meta.stream = attrs.stream;
        }
        return { meta, op, tx, coordinate, path, renderedLeaf, target, description };
    }

    // The row's result facts from its rx, added to the metadata line stage by stage: the attachments and the
    // returned address, the terminal stream's exit, the Problem or detail, the retrieval extents, and the
    // structured mutation receipts. Returns what the body projection needs to know about the result.
    static rowResultFacts(identity: RowIdentity, e: LogEntryView, rx: RxView | null, fullBody: ResolvedLogBody): RowResultFacts {
        const { meta, op } = identity;
        if (op === "SEND" && rx !== null && typeof rx === "object" && Array.isArray(rx.attachments) && rx.attachments.length > 0) {
            meta.attachments = rx.attachments.map(({ name, mediaType, target }) => ({ name, mediaType, path: target }));
        }
        // {§log-wire-format}: preserve the returned address, not a second authored target.
        if (rx !== null && typeof rx === "object" && typeof rx.resource === "string"
            && rx.resource.length > 0 && rx.resource !== identity.target && rx.resource !== meta.stream) {
            meta.resource = rx.resource;
        }
        PacketRowFacts.#streamReadFacts(meta, op, rx);
        PacketRowFacts.#problemFacts(identity, e, rx);
        const { findItems, range } = PacketRowFacts.#retrievalFacts(identity, e, rx, fullBody);
        const structuredMutationReceipt = PacketRowFacts.#mutationReceiptFacts(meta, op, rx);
        return {
            findItems, range, structuredMutationReceipt,
            ...(op === "READ" && rx?.matches !== undefined
                ? { matches: SchemeResults.assertMatchEvidenceList(rx.matches) } : {}),
        };
    }

    static #receiptMeta(value: unknown): Record<string, string | number> {
        const receipt: EditReceipt = assertEditReceipt(value);
        // The durable receipt keeps the full revision for forensics; the model gets no token it
        // cannot use.
        const head = {
            extent: `${receipt.unit} ${receipt.before}->${receipt.after}`,
            ...(receipt.parseIssues === undefined
                ? {}
                : { parseIssues: `${receipt.parseIssues.before}->${receipt.parseIssues.after}` }),
        };
        if ("effect" in receipt) {
            return {
                ...head,
                change: `${receipt.unit} -${receipt.effect.removed} +${receipt.effect.inserted}`,
                effect: `${receipt.effect.source} -> ${receipt.effect.result}`,
                // {§edit-result-receipt-projection} — what a deletion took, so it can be put back from the receipt.
                ...(receipt.effect.removedText === undefined ? {} : { removed: receipt.effect.removedText }),
            };
        }
        return {
            ...head,
            disposition: receipt.disposition,
            requested: receipt.requested,
            ...(receipt.replacement === undefined
                ? {}
                : {
                    change: `${receipt.unit} -${receipt.replacement.removed} +${receipt.replacement.inserted}`,
                    replacement: `${receipt.replacement.source} -> ${receipt.replacement.result}`,
                }),
        };
    }

    // {§exec-stream}: explicit and automatic READs preserve the same
    // durable liveness facts, including an empty active channel.
    static #streamReadFacts(meta: RowIdentity["meta"], op: RowIdentity["op"], rx: RxView | null): void {
        if (op === "READ" && rx !== null && typeof rx === "object" && Object.hasOwn(rx, "terminal")) {
            if (typeof rx.terminal !== "boolean") {
                throw new TypeError("A stream READ result carries a malformed terminal flag.");
            }
            meta.terminal = rx.terminal;
            if (Object.hasOwn(rx, "exitCode")) {
                if (typeof rx.exitCode !== "number" || !Number.isSafeInteger(rx.exitCode)) {
                    throw new TypeError("A stream READ result carries a malformed exitCode.");
                }
                meta.exitCode = rx.exitCode;
            }
            // {§executor-results} — a producer's full-page fact survives projection as written.
            if (Object.hasOwn(rx, "page")) {
                const page = rx.page;
                if (!isRecord(page) || !isSafeInteger(page.size) || !isSafeInteger(page.returned)) {
                    throw new TypeError("A stream READ result carries a malformed page.");
                }
                meta.page = { size: page.size, returned: page.returned };
            }
        }
    }

    // {§diagnostic-observation} — the exact durable Problem remains the
    // failure authority; the packet carries only facts not already
    // owned by its enclosing row. Errors remains only an index.
    // The success-side sibling (#342): a sub-problem receipt may carry one
    // terse `detail` (e.g. the EDIT 304) so situational teaching is paid
    // only when the situation occurs, never in the hot path.
    static #problemFacts(identity: RowIdentity, e: LogEntryView, rx: RxView | null): void {
        const { meta } = identity;
        if (typeof e.status === "number" && e.status >= 400 && rx !== null && typeof rx === "object") {
            const problem = Validator.assertProblemDetails(rx.problem);
            meta.problem = Problems.project(problem, {
                status: e.status,
                row: { ...meta, target: identity.target },
            });
        }
        if (!Object.hasOwn(meta, "problem") && rx !== null && typeof rx.detail === "string" && rx.detail.length > 0) {
            meta.detail = rx.detail;
        }
    }

    // {§log-wire-format}: one extent/coordinate owner plus
    // only FIND aggregates that add information beyond that extent.
    static #retrievalFacts(identity: RowIdentity, e: LogEntryView, rx: RxView | null, fullBody: ResolvedLogBody): { findItems: number | null; range: RangeExtent | null } {
        const { meta, op, tx } = identity;
        let findItems: number | null = null;
        let range: RangeExtent | null = null;
        const patterned = tx !== null && tx !== undefined && typeof tx === "object" && isRecord(tx.matcher) && typeof tx.matcher.raw === "string";
        if (patterned && op !== "FIND" && rx !== null && typeof rx === "object" && typeof rx.matched === "number") meta.matched = rx.matched;
        // {§channel-selection} — a READ names the resource's other channels with their
        // tokens, so the row itself shows the choice a FIND listing would.
        if (op === "READ" && rx !== null && typeof rx === "object" && rx.channels !== null && typeof rx.channels === "object") {
            meta.channels = rx.channels;
        }
        // {§message-completion} — a reply's row names the prompts it answered.
        if ((op === "SEND" || op === "KILL") && rx !== null && typeof rx === "object" && Array.isArray(rx.repliedTo)) {
            meta.repliedTo = rx.repliedTo;
        }
        if (op === "READ" || op === "FIND") {
            if (op === "FIND" && rx !== null && typeof rx === "object" && typeof rx.content === "string") {
                const parsed = PacketRowFacts.safeParse(rx.content);
                if (Array.isArray(parsed)) findItems = parsed.length;
            }
            range = rx !== null && typeof rx === "object" && rx.range !== undefined
                ? Validator.assertRangeExtent(rx.range)
                : null;
            const problem = isRecord(meta.problem) ? meta.problem : null;
            const problemOwnsRange = typeof e.status === "number" && e.status >= 400 && problem !== null && Object.hasOwn(problem, "range");
            if (problemOwnsRange) {
                Validator.assertRangeExtent(problem?.range);
                delete meta.scope;
            }
            if (range !== null && !problemOwnsRange) {
                delete meta.scope;
                const sparse = fullBody.lineOrdinals !== undefined
                    && range.returned !== undefined
                    && fullBody.lineOrdinals.length !== range.returned[1] - range.returned[0] + 1;
                // A row whose Problem does not own the range retrieved successfully, even when it
                // carries its execution's failure: its extent takes the one scope notation.
                meta.range = ScopeFormat.range(range, sparse);
            } else if (range === null && !problemOwnsRange && op === "READ" && rx !== null && typeof rx === "object" && rx.region !== undefined) {
                delete meta.scope;
                meta.range = ScopeFormat.region(Validator.assertTextRegion(rx.region));
            }
            // These are underlying selected-content weights, distinct from
            // the emitted body's generic `tokens` measurement.
            if (op === "FIND" && rx !== null && typeof rx === "object" && typeof rx.itemsWeightTotal === "number" && rx.itemsWeightTotal > 0) {
                meta.itemsTokenTotal = rx.itemsWeightTotal;
            }
            if (
                op === "FIND"
                && rx !== null
                && typeof rx === "object"
                && typeof rx.returnedItemsWeightTotal === "number"
                && rx.returnedItemsWeightTotal > 0
                && rx.returnedItemsWeightTotal !== rx.itemsWeightTotal
            ) {
                meta.returnedItemsTokenTotal = rx.returnedItemsWeightTotal;
            }
            if (
                op === "FIND"
                && patterned
                && range?.unit === "resource"
                && rx !== null
                && typeof rx === "object"
                && typeof rx.matchLocationCount === "number"
                && rx.matchLocationCount > 0
            ) {
                meta.matchLocationCount = rx.matchLocationCount;
            }
        }
        return { findItems, range };
    }

    // {§edit-result-receipt-projection} {§edit-result-receipt-projection}
    // EDIT/scoped entry KILL own one receipt; COPY/MOVE own resource effects whose
    // optional receipts describe scoped textual materializations.
    static #mutationReceiptFacts(meta: RowIdentity["meta"], op: RowIdentity["op"], rx: RxView | null): boolean {
        let structuredMutationReceipt = false;
        if ((op === "EDIT" || op === "KILL") && rx !== null && typeof rx === "object" && Object.hasOwn(rx, "receipt")) {
            Object.assign(meta, PacketRowFacts.#receiptMeta(rx.receipt));
            structuredMutationReceipt = true;
        }
        if (
            (op === "COPY" || op === "MOVE")
            && rx !== null
            && typeof rx === "object"
            && Object.hasOwn(rx, "effects")
        ) {
            const effects = assertResourceEffects(rx.effects);
            meta.effects = effects.map((effect) => ({
                path: effect.target,
                action: effect.action,
                ...(effect.receipt === undefined
                    ? {}
                    : PacketRowFacts.#receiptMeta(effect.receipt)),
            }));
            structuredMutationReceipt = effects.some((effect) => effect.receipt !== undefined);
        }
        return structuredMutationReceipt;
    }

    static #projectRelativeCwd(cwd: string, projectRoot: string | null): string | null {
        if (projectRoot === null || cwd === projectRoot) return null;
        const spelled = relative(projectRoot, cwd);
        return spelled.length === 0 ? null : spelled.split(sep).join("/");
    }

    static #operandPath(target: ActionTarget | null | undefined, projectRoot: string | null, authored: ParsedPath | null): string | null {
        if (target === null || target === undefined) return null;
        if (typeof target.raw === "string" && (target.kind === "local" || target.scheme == null)) {
            return renderAuthoredTarget({ kind: "local", raw: target.raw, fragment: target.fragment ?? null });
        }
        return PacketRowFacts.#renderActionTarget(target, projectRoot, authored);
    }

    static #renderActionTarget(target: ActionTarget | null | undefined, projectRoot: string | null, authored: ParsedPath | null): string | null {
        if (target === null || target === undefined) return null;
        return renderTarget({
            scheme: target.scheme,
            hostname: target.hostname,
            port: target.port,
            pathname: target.pathname,
            query: target.query,
            fragment: target.fragment,
        }, projectRoot, authored);
    }

    static #requestScope(marker: unknown): string | null {
        if (marker === null || marker === undefined) return null;
        const marks = isRecord(marker) ? marker.marks : undefined;
        const isMark = (mark: unknown): mark is number | string => typeof mark === "string" || typeof mark === "number";
        if (!Array.isArray(marks) || !marks.every(isMark)) {
            throw new TypeError("An operation scope must retain its authored marks.");
        }
        const [first, ...rest] = marks;
        if (first === undefined) throw new TypeError("An operation scope must retain its authored marks.");
        // Failed selections still describe what was attempted; the operation owns validity.
        return ScopeFormat.marker({ marks: [first, ...rest] });
    }

    // {§packet} A stored operand target: the address columns as nullable strings, the port a number, the
    // authored `kind` and `raw` read where used. A field of another type is a malformed row.
    static #actionTarget(value: unknown): ActionTarget | null {
        if (value === null || value === undefined) return null;
        if (!isRecord(value)) throw new TypeError("A stored operand target must be an object.");
        const text = (name: string): string | null | undefined => {
            const field = value[name];
            if (field === undefined || field === null || typeof field === "string") return field;
            throw new TypeError(`A stored operand target carries a malformed ${name}.`);
        };
        const port = value.port;
        if (port !== undefined && port !== null && typeof port !== "number") {
            throw new TypeError("A stored operand target carries a malformed port.");
        }
        return {
            kind: value.kind, raw: value.raw, scheme: text("scheme"), hostname: text("hostname"), port, pathname: text("pathname"),
            query: text("query"), fragment: text("fragment"), username: text("username"), password: text("password"),
        };
    }

    // The target as the model authored it, when the stored statement's target is a path the grammar names; a row
    // whose stored target is not renders without its authored spelling.
    static #authoredPath(value: unknown): ParsedPath | null {
        if (value === null || value === undefined) return null;
        return Validator.validateParsedPath(value).valid ? Validator.assertParsedPath(value) : null;
    }

    static #selection(value: unknown): StatementTx | null {
        return isRecord(value) ? value : null;
    }

    static #metadata(value: unknown): readonly string[] | null {
        if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) return null;
        const visible = value.filter((item) => item !== "__redacted__");
        return visible.length > 0 ? visible : null;
    }
}
