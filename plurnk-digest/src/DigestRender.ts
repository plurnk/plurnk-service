// Digest renderers ({§digest-programmatic-surface}): the markdown, JSON, reasoning, and packet
// artifacts of one DigestModel, reading heavy evidence on demand through DigestEvidence.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
    aggregateProviderAccounting,
    type ProviderAccounting,
    type ProviderRequestAccounting,
    type ChatMessage,
} from "@plurnk/plurnk-providers";
import { Validator, type OperationResult, type ProblemDetails } from "@plurnk/plurnk-contracts";
import type {
    WorkerRow,
    LoopRow,
    TurnRow,
    ProviderRequestRow,
    LogRow,
    EditRow,
    EditCensus,
    EditForm,

    DigestModel,
    CacheLedgerEntry,
} from "./digest-rows.ts";
import { EDIT_FORMS } from "./digest-rows.ts";
import { isExecutionOp } from "@plurnk/plurnk-contracts";

function* projectRows<T, R>(rows: Iterable<T>, project: (row: T) => R): Generator<R> {
    for (const row of rows) yield project(row);
}

export default class DigestRender {
    static #summarize(text: unknown, n = 80): string {
        if (text === null || text === undefined) return "";
        const flat = String(text).replace(/\s+/g, " ").trim();
        if (flat.length <= n) return flat;
        return `${flat.slice(0, n)}…`;
    }

    static #indentLines(text: string, prefix = "    "): string {
        return text.split("\n").map((line) => line.length > 0 ? `${prefix}${line}` : line).join("\n");
    }

    static parseJson(s: unknown, fallback: unknown = null): unknown {
        if (s === null || s === undefined) return fallback;
        try { return JSON.parse(String(s)); } catch { return fallback; }
    }

    static #requestAccounting(row: ProviderRequestRow): ProviderRequestAccounting {
        if (row.state !== "settled" || row.accounting === null) {
            throw new TypeError(`digest: provider request ${row.id} is not settled`);
        }
        return row.accounting;
    }

    static #accounting(rows: readonly ProviderRequestRow[]): ProviderAccounting | null {
        return rows.some((row) => row.state !== "settled")
            ? null
            : aggregateProviderAccounting(rows.map((row) => DigestRender.#requestAccounting(row)));
    }

    static usageSummary(accounting: ProviderAccounting | null): string {
        if (accounting === null) return "accounting=incomplete";
        const usage = accounting.usage;
        const known = accounting.knownUsage;
        const quantity = (total: number | undefined, subtotal: number | undefined): string =>
            total !== undefined ? String(total) : subtotal === undefined ? "unknown" : `${subtotal}+?`;
        return [
            `input=${quantity(usage?.inputTokens, known?.inputTokens)}`,
            `output=${quantity(usage?.outputTokens, known?.outputTokens)}`,
            `reasoning=${quantity(usage?.outputTokenDetails?.reasoningTokens, known?.outputTokenDetails?.reasoningTokens)}`,
            `cache-read=${quantity(usage?.inputTokenDetails?.cacheReadTokens, known?.inputTokenDetails?.cacheReadTokens)}`,
        ].join(" ");
    }

    static costSummary(accounting: ProviderAccounting | null): string {
        if (accounting?.costUsd != null) return `$${accounting.costUsd}`;
        return accounting?.knownCostUsd == null ? "unknown" : `$${accounting.knownCostUsd} + ? (incomplete)`;
    }

    static #operationResult(raw: unknown, subject: string): OperationResult {
        try {
            return Validator.assertOperationResult(DigestRender.parseJson(raw) as OperationResult);
        } catch (cause) {
            throw new Error(`digest: ${subject} does not contain a valid operation result`, { cause });
        }
    }

    static #rowProblem(row: LogRow): ProblemDetails {
        const result = DigestRender.#operationResult(row.rx, `failed log entry ${row.id}`);
        if (result.problem === undefined) {
            throw new Error(`digest: failed log entry ${row.id} does not contain Problem Details`);
        }
        return result.problem;
    }

    static #terminalResult(loop: LoopRow): OperationResult | null {
        return loop.terminal_result === null
            ? null
            : DigestRender.#operationResult(loop.terminal_result, `terminal loop ${loop.id}`);
    }

    static #renderTarget(le: LogRow): string | null {
        return le.target;
    }

    static #renderStream(le: LogRow): string | null {
        if (!isExecutionOp(le.op)) return null;
        const stream = (DigestRender.parseJson(le.attrs, {}) as { stream?: unknown }).stream;
        return typeof stream === "string" ? stream : null;
    }

    // {§exec-env-scoped} — the environment a spawn received, as recorded on its row: host names by
    // name, the Worker's own values, inherited values by their source, masked names. Host values
    // stay in digest.json. Part of the rendered line, so spawns under different environments never
    // collapse into one group.
    static envLine(env: unknown): string | null {
        if (env === undefined || env === null || typeof env !== "object") return null;
        const host: string[] = [];
        const rest: string[] = [];
        for (const [name, raw] of Object.entries(env as Record<string, unknown>).toSorted(([left], [right]) => left.localeCompare(right))) {
            const record = raw as { source?: unknown; from?: unknown; value?: unknown };
            const from = typeof record.from === "string" ? record.from : null;
            if (record.source === "host") host.push(name);
            else if (record.source === "masked") rest.push(`${name} (masked${from === null ? "" : ` by ${from}`})`);
            else if (record.source === "modifier") rest.push(`${name}=${DigestRender.#summarize(record.value, 60)} (modifier)`);
            else if (record.source === "workspace") rest.push(`${name}=${DigestRender.#summarize(record.value, 60)} (workspace)`);
            else rest.push(`${name}=${DigestRender.#summarize(record.value, 60)} (${from === null ? "worker" : `from ${from}`})`);
        }
        const parts = [...(host.length === 0 ? [] : [`host ${host.join(",")}`]), ...rest];
        return `env: ${parts.length === 0 ? "(empty)" : parts.join(" · ")}`;
    }

    // The environment a spawn recorded on its output, found through the row's stream address.
    static #environmentOf(le: LogRow, m: DigestModel): unknown {
        const stream = DigestRender.#renderStream(le);
        if (stream === null) return undefined;
        const worker = m.workersById.get(le.worker_id);
        return worker === undefined ? undefined : m.environments.get(`${worker.workspace_id}:${stream}`);
    }

    static #renderOpLine(le: LogRow, label: string = le.op ?? "source artifact", environment?: unknown): string {
        const target = DigestRender.#renderTarget(le) ?? "—";
        const stream = DigestRender.#renderStream(le);
        const state = le.state !== "resolved" ? ` state=${le.state}` : "";
        const outcome = le.outcome !== null ? ` outcome=${le.outcome}` : "";
        const streamLink = stream === null ? "" : ` stream=${stream}`;
        const source = le.source === null ? "" : ` source=${le.source}`;
        const fail = le.status_rx >= 400 ? " ✗" : "";
        // For failed outcomes, surface the Problem Details explanation from rx so
        // the waterfall explains WHY each failure happened without opening packets.
        let errLine = "";
        if (le.status_rx >= 400) {
            errLine = `\n    -> ${DigestRender.#rowProblem(le).detail.trim()}`;
        }
        const envLine = DigestRender.envLine(environment);
        const envText = envLine === null ? "" : `\n    ${envLine}`;
        return `  ← [${le.origin}] ${label}[${le.status_rx}] ${target}${source}${state}${outcome}${streamLink}${fail}${errLine}${envText}`;
    }

    static #renderGroupedOpLine(row: LogRow, m: DigestModel): string {
        const attrs = DigestRender.parseJson(row.attrs, {}) as { kind?: unknown };
        // {§emission-row}: the announcement of an admitted emission, and whether the model retired it.
        if (row.op === "READ" && attrs.kind === "emission") {
            return DigestRender.#renderOpLine(row, row.projection_active === 1 ? "emission" : "emission (killed)", DigestRender.#environmentOf(row, m));
        }
        // {§reasoning-row}: the turn's reasoning landed as a row, and whether the model retired it.
        if (row.op === "READ" && attrs.kind === "reasoning") {
            return DigestRender.#renderOpLine(row, row.projection_active === 1 ? "reasoning" : "reasoning (killed)", DigestRender.#environmentOf(row, m));
        }
        const materialized = row.origin === "_plurnk" && row.op === "EDIT" && attrs.kind === "entry_materialized";
        const actionlessKind = row.op === null ? attrs.kind : null;
        const label = actionlessKind === "emissionAttempt"
            ? "emission attempt"
            : row.op ?? `unrecognized actionless row (kind=${JSON.stringify(actionlessKind) ?? "absent"})`;
        return DigestRender.#renderOpLine(row, materialized ? "materialized entry" : label, DigestRender.#environmentOf(row, m));
    }

    // Human triage is not a row dump. Preserve every row in digest.json, but
    // collapse consecutive identical rendered outcomes in the Markdown waterfall. Using the
    // rendered line itself as the key keeps actor, complete target, lifecycle,
    // stream, and visible failure detail structurally aligned with the grouping.
    static #renderOpLines(rows: LogRow[], m: DigestModel): string[] {
        const runs: Array<{ line: string; count: number; firstSeq: number; lastSeq: number }> = [];
        for (const row of rows) {
            const line = DigestRender.#renderGroupedOpLine(row, m);
            const last = runs.at(-1);
            if (last !== undefined && last.line === line) {
                last.count++;
                last.lastSeq = row.sequence;
            } else {
                runs.push({ line, count: 1, firstSeq: row.sequence, lastSeq: row.sequence });
            }
        }
        return runs.map(({ line, count, firstSeq, lastSeq }) => {
            return count === 1 ? line : `${line} ×${count} (seq ${firstSeq}–${lastSeq})`;
        });
    }

    // The "degenerate win" lens (owner ask): a loop's health = how many errors/strikes it earned
    // vs whether it still concluded. A green that limped across on 16 errors is a FAILING artifact
    // wearing a passing badge; the digest must make that impossible to miss. errors = ≥400 op rows;
    // errorItems = minted op='error' rows (truncation/budget/steer/cycle — the strike signals).
    // {§digest-executor-evidence} (#436) — a failed command's completion rows carry the
    // executor's problem identity; a red test run is the loop's normal work, not a
    // defect. They stay visible but never count as errors in health or the errs
    // badge — the digest mirror of the strike rail's exemption (#425 F1).
    static #isExecutorEvidence(le: LogRow): boolean {
        if (le.status_rx < 400 || le.rx === null) return false;
        const rx = DigestRender.parseJson(le.rx, null) as { problem?: { type?: unknown } } | null;
        return typeof rx?.problem?.type === "string"
            && rx.problem.type.startsWith("https://problems.plurnk.xyz/executor/");
    }

    // {§digest-storage} — size, free pages, vacuum mode and the largest tables, one line.
    static #storageLine(storage: DigestModel["storage"]): string {
        const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;
        const mode = ["off", "full", "incremental"][storage.auto_vacuum] ?? String(storage.auto_vacuum);
        return `Storage: ${mb(storage.bytes)} (free ${mb(storage.free_bytes)}, auto_vacuum ${mode}) · largest: ${storage.tables.map(({ name, bytes }) => `${name} ${mb(bytes)}`).join(", ")}`;
    }

    // {§loop-claim-latency} — claim to first model turn: a stall between them is a number, not a gap.
    static #wakeLatency(loop: LoopRow, m: DigestModel): string | null {
        if (loop.claimed_at === null) return null;
        const first = (m.turnsByLoop.get(loop.id) ?? []).filter((t) => t.kind === "inference").sort((a, b) => a.sequence - b.sequence)[0];
        if (first === undefined) return `Claimed: ${loop.claimed_at} · no model turn`;
        const seconds = (Date.parse(first.timestamp) - Date.parse(loop.claimed_at)) / 1000;
        return `Claimed: ${loop.claimed_at} · first model turn +${seconds.toFixed(1)} s`;
    }

    // {§digest-cache-ledger} — the reconstructed text envelope, each role above its content,
    // as `.wire.json` holds it ({§share-packet-names}); null when no valid packet is stored.
    static #promptText(turn: TurnRow, m: DigestModel): string | null {
        const { packet } = m.evidence.packet(turn);
        if (packet === null) return null;
        return packet.messages()
            .map(({ role, content }) => `${role}\n${content}`)
            .join("\n");
    }

    static #commonPrefixLength(left: string, right: string): number {
        const bound = Math.min(left.length, right.length);
        let n = 0;
        while (n < bound && left.charCodeAt(n) === right.charCodeAt(n)) n += 1;
        return n;
    }

    // {§digest-edit-census}: the form an EDIT authored, read from its stored marker and pattern.
    static editForm(row: Pick<EditRow, "line_marker" | "pattern">): EditForm {
        if (row.pattern !== null) return "pattern";
        if (row.line_marker === null) return "whole";
        const { marks } = DigestRender.parseJson(row.line_marker, { marks: [] }) as { marks: Array<number | string> };
        if (marks.length === 1) {
            const [mark] = marks;
            if (typeof mark === "string") return "hash";
            if (mark === -1) return "append";
            if (mark === 0) return "prepend";
            return "line";
        }
        if (marks.length === 2) return "range";
        if (marks.length === 3) return "offset";
        if (marks.length === 4 && marks[0] === marks[2] && marks[1] === 1 && marks[3] === 1) return "insert";
        return "column";
    }

    static #editCensusCache = new WeakMap<DigestModel, { byWorker: Map<number, EditCensus>; formById: Map<number, EditForm>; revisitById: Set<number> }>();

    // {§digest-edit-census}: per worker, every model EDIT by authored form and status, and the
    // revisits — an EDIT of a path the same worker edited within its previous two model turns.
    static #editCensus(m: DigestModel): { byWorker: Map<number, EditCensus>; formById: Map<number, EditForm>; revisitById: Set<number> } {
        const cached = DigestRender.#editCensusCache.get(m);
        if (cached !== undefined) return cached;
        const loopWorker = new Map(m.loops.map((loop) => [loop.id, loop.worker_id]));
        // A worker's model turns in order; the ordinal is the distance the revisit window counts in.
        const ordinal = new Map<number, number>();
        const perWorker = new Map<number, number>();
        for (const turn of [...m.turns].sort((a, b) => a.id - b.id)) {
            if (turn.producer !== "model") continue;
            const workerId = loopWorker.get(turn.loop_id);
            if (workerId === undefined) throw new TypeError(`digest: turn ${turn.id} has no loop in scope`);
            const next = (perWorker.get(workerId) ?? 0) + 1;
            perWorker.set(workerId, next);
            ordinal.set(turn.id, next);
        }
        const byWorker = new Map<number, EditCensus>();
        const formById = new Map<number, EditForm>();
        const revisitById = new Set<number>();
        for (const [workerId, rows] of m.editRowsByWorker) {
            const census: EditCensus = { edits: 0, refused: 0, revisits: 0, forms: Object.fromEntries(EDIT_FORMS.map((form) => [form, 0])) as Record<EditForm, number> };
            const lastEdited = new Map<string, number>();
            for (const row of rows) {
                const form = DigestRender.editForm(row);
                formById.set(row.id, form);
                census.edits += 1;
                census.forms[form] += 1;
                if (row.status_rx >= 400) census.refused += 1;
                const at = ordinal.get(row.turn_id);
                if (at === undefined) throw new TypeError(`digest: EDIT ${row.id} sits on a turn no model produced`);
                if (row.pathname !== null) {
                    const previous = lastEdited.get(row.pathname);
                    if (previous !== undefined && previous < at && at - previous <= 2) { census.revisits += 1; revisitById.add(row.id); }
                    lastEdited.set(row.pathname, at);
                }
            }
            byWorker.set(workerId, census);
        }
        const result = { byWorker, formById, revisitById };
        DigestRender.#editCensusCache.set(m, result);
        return result;
    }

    static #renderEditCensus(census: EditCensus | undefined): string {
        if (census === undefined || census.edits === 0) return "(no edits)";
        const forms = EDIT_FORMS.filter((form) => census.forms[form] > 0).map((form) => `${form}=${census.forms[form]}`).join(" ");
        return `${census.edits} · ${forms} · refused=${census.refused} · revisits=${census.revisits}`;
    }

    static #cacheLedgerCache = new WeakMap<DigestModel, Map<number, CacheLedgerEntry>>();

    // {§digest-cache-ledger} — estimate adjacent prefixes with at most two prompts resident per loop.
    static cacheLedger(m: DigestModel): Map<number, CacheLedgerEntry> {
        const cached = DigestRender.#cacheLedgerCache.get(m);
        if (cached !== undefined) return cached;
        const turnsById = new Map(m.turns.map((turn) => [turn.id, turn]));
        const ledger = new Map<number, CacheLedgerEntry>();
        for (const loop of m.loops) {
            let memo: { turnId: number; text: string | null } | undefined;
            const promptOf = (turn: TurnRow): string | null => {
                if (memo?.turnId !== turn.id) memo = { turnId: turn.id, text: DigestRender.#promptText(turn, m) };
                return memo.text;
            };
            // undefined: no previous request in this loop; null: the previous request's packet is not valid.
            let previousText: string | null | undefined;
            for (const request of m.requestsByLoop.get(loop.id) ?? []) {
                const turn = turnsById.get(request.turn_id);
                if (turn === undefined) throw new TypeError(`digest: provider request ${request.id} has no turn in scope`);
                const text = request.kind === "emission" ? promptOf(turn) : null;
                const adjacentPrefixTokensEstimate = text === null || request.usage_input === null
                    ? null
                    : previousText === undefined
                        ? 0
                        : previousText === null
                            ? null
                            : text.length === 0
                                ? 0
                                : Math.round(request.usage_input * m.evidence.textWeight(text.slice(0, DigestRender.#commonPrefixLength(previousText, text))) / m.evidence.textWeight(text));
                ledger.set(request.id, {
                    adjacentPrefixTokensEstimate,
                    cachedTokens: request.usage_input_cache_read,
                    inputTokens: request.usage_input,
                });
                previousText = text;
            }
        }
        for (const request of m.providerRequests) {
            if (!ledger.has(request.id)) throw new TypeError(`digest: provider request ${request.id} has no loop in scope`);
        }
        DigestRender.#cacheLedgerCache.set(m, ledger);
        return ledger;
    }

    static #cacheEntries(requests: readonly ProviderRequestRow[], m: DigestModel): CacheLedgerEntry[] {
        const ledger = DigestRender.cacheLedger(m);
        return requests.map((request) => ledger.get(request.id)!);
    }

    // {§digest-cache-ledger} — sum each provider-reported counter; one absent quantity makes that sum unknown.
    static #cacheBadge(turn: TurnRow, m: DigestModel): string {
        const entries = DigestRender.#cacheEntries(m.requestsByTurn.get(turn.id) ?? [], m);
        if (entries.length === 0) return "";
        const sum = (values: Array<number | null>): string => values.some((value) => value === null)
            ? "?"
            : String(values.reduce<number>((total, value) => total + (value as number), 0));
        return ` cache=${sum(entries.map((entry) => entry.cachedTokens))}/${sum(entries.map((entry) => entry.inputTokens))}`;
    }

    // {§digest-cache-ledger} — one workspace line; unreported requests are named and left out of the percentage.
    static #cacheLine(requests: readonly ProviderRequestRow[], m: DigestModel): string {
        const entries = DigestRender.#cacheEntries(requests, m);
        const reported = entries.filter((entry) => entry.cachedTokens !== null && entry.inputTokens !== null);
        const unreported = entries.length - reported.length;
        const cached = reported.reduce((total, entry) => total + (entry.cachedTokens as number), 0);
        const input = reported.reduce((total, entry) => total + (entry.inputTokens as number), 0);
        const pct = input === 0 ? "n/a" : `${((100 * cached) / input).toFixed(1)}%`;
        const plural = (n: number): string => n === 1 ? "request" : "requests";
        return [
            `Cache: ${cached} of ${input} reported input tokens read from cache (${pct}) over ${reported.length} ${plural(reported.length)}`,
            unreported > 0 ? `${unreported} missing input or cache usage (excluded)` : null,
        ].filter((part) => part !== null).join(" · ");
    }

    static #loopHealth(loop: LoopRow, m: DigestModel): { errors: number; errorItems: number; verdict: string } {
        let errors = 0;
        let errorItems = 0;
        for (const t of m.turnsByLoop.get(loop.id) ?? []) {
            for (const le of m.logEntriesByTurn.get(t.id) ?? []) {
                if (le.status_rx >= 400 && !DigestRender.#isExecutorEvidence(le)) errors += 1;
                if (le.op === "error") errorItems += 1;
            }
        }
        const s = loop.status;
        const verdict = s >= 400 ? `FAILED(${s})`
            : s >= 200 && s < 300 ? (errors > 0 ? "DEGENERATE-WIN" : "CLEAN")
            : `status=${s}`;
        return { errors, errorItems, verdict };
    }

    static #renderTurnLine(turn: TurnRow, m: DigestModel): string {
        const { packet, packetFailure } = m.evidence.packet(turn);
        const assistant = packet?.assistant ?? null;
        const content = assistant?.content ?? "";
        const reasoning = assistant?.reasoning ?? null;
        const accounting = DigestRender.#accounting(m.requestsByTurn.get(turn.id) ?? []);
        const tokens = DigestRender.usageSummary(accounting);
        const cost = ` cost=${DigestRender.costSummary(accounting)}`;
        const finishReason = turn.finish_reason ?? "—";
        // Render only observed transport metadata; absence makes no claim
        // about endpoint-owned settings. {§operator-grammar}
        const tm = DigestRender.parseJson(turn.meta ?? "null", null) as { railsAttached?: boolean | string } | null;
        const attached = tm?.railsAttached;
        const rails = attached === undefined || attached === false ? ""
            : ` rails=${attached === true ? "client" : attached}`;
        const model = turn.model ?? "—";
        // {§outside-text}: the weight the model was told, so a digest reader sees the discard at a glance.
        const outside = turn.outside === null ? "" : ` outside=${m.evidence.textWeight(turn.outside)} tok`;
        const errs = (m.logEntriesByTurn.get(turn.id) ?? [])
            .filter((le) => le.status_rx >= 400 && !DigestRender.#isExecutorEvidence(le)).length;
        const errBadge = errs > 0 ? `  ⚠ errs=${errs}` : "";
        const attempts = m.attemptsByTurn.get(turn.id) ?? [];
        const rejected = attempts.filter((attempt) => attempt.accepted === 0).length;
        const errored = attempts.filter((attempt) => attempt.state === "error").length;
        const pending = attempts.filter((attempt) => attempt.state === "pending").length;
        const attemptConditions = [
            rejected > 0 ? `rejected-emissions=${rejected}` : null,
            errored > 0 ? `call-errors=${errored}` : null,
            pending > 0 ? `open-calls=${pending}` : null,
        ].filter((part) => part !== null);
        const attemptBadge = attemptConditions.length === 0
            ? ""
            : `  ⚠ ${attemptConditions.join(" ")}/${attempts.length}`;
        const packetBadge = packetFailure === null ? "" : "  ⚠ packet=invalid";
        const stem = DigestRender.packetStems(m).get(turn.id);
        const modelTurn = DigestRender.#modelTurnOrdinal(turn, m);
        const provenance = [modelTurn === null ? null : `model turn ${modelTurn}`, stem].filter((part) => part !== null).join(" · ");
        const lifecycle = `T${turn.sequence}${provenance === "" ? "" : ` (${provenance})`}: producer=${turn.producer} kind=${turn.kind} status=${turn.status}${turn.completed_at === null ? " state=open" : ""}`;
        const head = turn.kind === "inference"
            ? `${lifecycle} finish=${finishReason}${rails} model=${model} ${tokens}${cost}${DigestRender.#cacheBadge(turn, m)}${outside}${errBadge}${attemptBadge}${packetBadge}`
            : `${lifecycle}${errBadge}${packetBadge}`;
        let summary: string | null = null;
        if (packetFailure !== null) {
            summary = `  ↳ provider packet: invalid stored evidence (${packetFailure.error.message})`;
        } else if (packet === null) {
            summary = null;
        } else if (content.length > 0) {
            summary = content.includes("\n")
                ? `  ↳ emission:\n${DigestRender.#indentLines(content.trimEnd(), "    ")}`
                : `  ↳ emission: ${content.trim()}`;
        } else if (assistant !== null) {
            summary = "  ↳ emission: (admitted empty)";
        } else if (rejected > 0) {
            summary = `  ↳ emission: (none admitted; ${rejected} rejected)`;
        } else {
            summary = "  ↳ emission: (none admitted)";
        }
        const reasoningLine = reasoning && reasoning.length > 0
            ? (reasoning.includes("\n")
                ? `  ↳ reasoning:\n${DigestRender.#indentLines(reasoning.trimEnd(), "    ")}`
                : `  ↳ reasoning: ${reasoning.trim()}`)
            : null;
        // {§provider-wire-emission} — an empty emission is read from what the wire carried, never guessed at.
        const wireLine = content.length === 0 && packet?.assistant != null ? DigestRender.wireLine(packet.assistantRaw) : null;
        const requestLine = packet === null ? null
            : `  ↳ request: ${packet.messages().map(({ role }) => role).join(" → ")} (${stem}.request.md)`;
        const opLines = DigestRender.#renderOpLines(m.logEntriesByTurn.get(turn.id) ?? [], m);
        return [head, ...(requestLine ? [requestLine] : []), ...(summary ? [summary] : []), ...(reasoningLine ? [reasoningLine] : []), ...(wireLine ? [wireLine] : []), ...opLines].join("\n");
    }

    // {§provider-wire-emission} — public so the line can be witnessed on its own.
    static wireLine(assistantRaw: unknown): string | null {
        const wire = typeof assistantRaw === "object" && assistantRaw !== null ? (assistantRaw as { wire?: unknown }).wire : undefined;
        if (typeof wire !== "object" || wire === null) return null;
        const { chunks, emptyChunks, fields, channels, toolCalls, unmappedChunks } = wire as {
            chunks?: number; emptyChunks?: number; fields?: Record<string, number>; channels?: Record<string, string>;
            toolCalls?: ReadonlyArray<{ name?: string; arguments: string }>;
            unmappedChunks?: readonly unknown[];
        };
        const parts = [
            `${chunks ?? 0} chunks`,
            (emptyChunks ?? 0) > 0 ? `${emptyChunks} carried nothing` : null,
            ...Object.entries(fields ?? {}).map(([field, count]) => `${field}×${count}`),
            ...(toolCalls ?? []).map((call) => `tool call ${call.name ?? "?"}(${DigestRender.#summarize(call.arguments, 60)})`),
            ...Object.entries(channels ?? {}).map(([channel, text]) => `${channel}: ${DigestRender.#summarize(text, 60)}`),
            (unmappedChunks?.length ?? 0) > 0 ? `${unmappedChunks!.length} unmapped frames retained` : null,
        ].filter((part) => part !== null);
        return `  ↳ wire: ${parts.join(", ")}`;
    }

    static #renderWorkerShape(worker: WorkerRow, m: DigestModel): string {
        // every worker has exactly one rollup row — digest_worker_rollups is FROM workers
        const roll = m.workerRollups.get(worker.id)!;
        const opMix = (m.opMixByWorker.get(worker.id) ?? []).map((o) => `${o.op}=${o.n}`).join(" ");
        const requests = m.requestsByWorker.get(worker.id) ?? [];
        const accounting = DigestRender.#accounting(requests);
        const usageStr = requests.length === 0
            ? "no provider requests"
            : DigestRender.usageSummary(accounting);
        const costStr = requests.length === 0
            ? "n/a"
            : DigestRender.costSummary(accounting);
        // {§digest-forensic-fidelity} (#461): settled exchanges that carry no usage at
        // all (errored/aborted) billed server-side invisibly; say so, never price-as-zero.
        const usageless = requests.filter((row) => row.state === "settled" && row.usage_total === null).length;
        const usagelessStr = usageless > 0
            ? ` (+${usageless} usage-less request${usageless === 1 ? "" : "s"} — server-side spend unrecorded)`
            : "";
        // {§digest-cost-kind} (#473): a dollar figure without its basis reads as billed
        // truth; carry the kind so an estimate can never impersonate a charge.
        const kinds = new Set(requests
            .filter((row) => row.state === "settled" && row.cost_kind !== null)
            .map((row) => row.cost_kind));
        const kindStr = costStr === "n/a" || costStr === "unknown"
            ? ""
            : kinds.has("estimated")
                ? " (estimated — catalog rates)"
                : kinds.has("charged")
                    ? " (charged)"
                    : "";
        // {§digest-wire-line} (#473): provider-level errors are absorbed by retries below
        // the packet stream, so only an aggregate line makes a rate-limit storm visible.
        const wireErrors = requests.filter((row) => row.outcome === "error").length;
        const wireStr = requests.length === 0
            ? "(no provider requests)"
            : `${requests.length} request${requests.length === 1 ? "" : "s"} · ${wireErrors} error${wireErrors === 1 ? "" : "s"}${wireErrors > 0 ? ` (${Math.round((100 * wireErrors) / requests.length)}%)` : ""}`;
        return [
            `Loops:      ${roll.loops}`,
            `Turns:      ${roll.turns}`,
            `Last turn:  ${roll.last_status !== null ? `status=${roll.last_status}` : "(none)"}`,
            `Tokens:     ${usageStr}`,
            `Cost:       ${costStr}${kindStr}${usagelessStr}`,
            `Wire:       ${wireStr}`,
            `Room:       ${DigestRender.#renderRoom(worker, m)}`,
            `Op mix:     ${opMix.length > 0 ? opMix : "(no ops)"}`,
            `EDITs:      ${DigestRender.#renderEditCensus(DigestRender.#editCensus(m).byWorker.get(worker.id))}`,
            `Emissions:  ${DigestRender.#renderEmissions(worker, m)}`,
            `Reasonings: ${DigestRender.#renderReasonings(worker, m)}`,
        ].join("\n");
    }

    // {§digest-room-line} — the room in provider tokens: the largest budget the model was shown, at its
    // request's own ratio, against the capacity; the wall's estimate against the provider's count; and the
    // requests the estimate put under the wall while the count was over it.
    static #renderRoom(worker: WorkerRow, m: DigestModel): string {
        const measured = DigestRender.#roomMeasures(worker, m);
        if (measured.length === 0) return "(no measured requests)";
        const room = Math.max(...measured.map(({ weight, budget, count, capacity }) => budget * count / weight / capacity));
        const errors = measured.map(({ estimate, count }) => (estimate - count) / count);
        const missed = measured.filter(({ estimate, count, wall }) => estimate <= wall && count > wall).length;
        const percent = (ratio: number): string => `${ratio < 0 ? "-" : "+"}${Math.abs(100 * ratio).toFixed(1)}%`;
        return `budget up to ${Math.round(100 * room)}% of capacity · wall estimate ${percent(Math.min(...errors))} to ${percent(Math.max(...errors))} of the count`
            + (missed === 0 ? "" : `  ⚠ ${missed} over the wall the estimate admitted`);
    }

    // One measure per packet-bearing inference turn whose request records a known capacity and wall and a
    // provider count: the exact preflight measurement, else the reported input.
    static #roomMeasures(worker: WorkerRow, m: DigestModel): Array<{ weight: number; budget: number; capacity: number; wall: number; count: number; estimate: number }> {
        const measures = [];
        for (const loop of m.loopsByWorker.get(worker.id) ?? []) {
            for (const turn of m.turnsByLoop.get(loop.id) ?? []) {
                if (turn.kind !== "inference" || turn.has_packet !== 1) continue;
                const packet = m.evidence.packet(turn).packet;
                if (packet === null || packet.budget === null || packet.budget === 0 || packet.weight === 0) continue;
                const call = m.modelCalls.findLast((row) => row.turn_id === turn.id && row.kind === "emission" && row.capacity !== null);
                const capacity = DigestRender.parseJson(call?.capacity) as {
                    inputCapacity?: number | null; inputWall?: number | null; prompt?: { kind?: string; tokens?: number };
                } | null;
                if (capacity?.inputCapacity == null || capacity.inputWall == null) continue;
                const reported = (m.requestsByTurn.get(turn.id) ?? [])
                    .findLast((row) => row.kind === "emission" && row.outcome === "response" && row.usage_input !== null)?.usage_input ?? null;
                const count = capacity.prompt?.kind === "exact" ? capacity.prompt.tokens ?? null : reported;
                if (count === null || count === 0) continue;
                measures.push({
                    weight: packet.weight, budget: packet.budget, capacity: capacity.inputCapacity, wall: capacity.inputWall, count,
                    estimate: Math.ceil(packet.weight * capacity.inputCapacity / packet.budget),
                });
            }
        }
        return measures;
    }

    // {§emission-row} — announced, retired by the model, and echoed back as headings in its own text.
    static #renderEmissions(worker: WorkerRow, m: DigestModel): string {
        const rows = m.emissionRows.filter((row) => row.worker_id === worker.id);
        const killed = rows.filter((row) => row.active === 0).length;
        const echoes = (m.loopsByWorker.get(worker.id) ?? [])
            .flatMap((loop) => m.turnsByLoop.get(loop.id) ?? [])
            .reduce((sum, turn) => sum + turn.packetEchoes, 0);
        return `${rows.length} announced · ${killed} killed · ${echoes} header echo${echoes === 1 ? "" : "es"}`;
    }

    // {§reasoning-row} — landed, retired by the model, and turns that reasoned.
    static #renderReasonings(worker: WorkerRow, m: DigestModel): string {
        const rows = m.reasoningRows.filter((row) => row.worker_id === worker.id);
        const killed = rows.filter((row) => row.active === 0).length;
        const reasonedTurns = (m.loopsByWorker.get(worker.id) ?? [])
            .flatMap((loop) => m.turnsByLoop.get(loop.id) ?? [])
            .filter((turn) => turn.has_reasoning === 1).length;
        if (reasonedTurns === 0 && rows.length === 0) return "(no reasoning)";
        if (rows.length === 0) return `0 of ${reasonedTurns} landed (unbudgeted or disabled)`;
        if (reasonedTurns > rows.length) return `${rows.length} of ${reasonedTurns} landed · ${killed} killed`;
        return `${rows.length} landed · ${killed} killed`;
    }

    static waterfall(m: DigestModel): string {
        const lines: string[] = [];
        lines.push(`# plurnk-service digest`);
        lines.push("");
        lines.push(`DB: ${m.dbPath}`);
        lines.push(DigestRender.#storageLine(m.storage));
        const rejectedAttempts = m.turnAttempts.filter((attempt) => attempt.accepted === 0).length;
        const erroredCalls = m.inferenceCalls.filter((call) => call.state === "error").length;
        const pendingCalls = m.inferenceCalls.filter((call) => call.state === "pending").length;
        const bareCalls = m.modelCalls.filter((call) => call.kind === "bare").length;
        const pendingRequests = m.providerRequests.filter((request) => request.state === "pending").length;
        const packetFailures = m.turns.filter((turn) => m.evidence.packet(turn).packetFailure !== null).length;
        lines.push(`Workspaces: ${m.workspaces.length}  Workers: ${m.workers.length}  Loops: ${m.loops.length}  Turns: ${m.turns.length}  Inference calls: ${m.inferenceCalls.length} (${bareCalls} BARE, ${erroredCalls} errored, ${pendingCalls} open)  Emission attempts: ${m.turnAttempts.length} (${rejectedAttempts} rejected)  Provider requests: ${m.providerRequests.length} (${pendingRequests} open)  Log entries: ${m.logEntries.length}`);
        if (packetFailures > 0) lines.push(`Stored packet failures: ${packetFailures}`);
        lines.push(`Search: channels=${m.search.channel_entries} attached=${m.search.derivation_complete} (indexed=${m.search.indexed} excluded=${m.search.excluded} unsearchable=${m.search.unsearchable} failed=${m.search.failed}) unattached=${m.search.unfinished} artifacts=${m.search.derivation_artifacts_complete} complete/${m.search.derivation_artifacts_building} building`);
        const health = m.loops.map((l) => DigestRender.#loopHealth(l, m));
        const clean = health.filter((h) => h.verdict === "CLEAN").length;
        const degen = health.filter((h) => h.verdict === "DEGENERATE-WIN").length;
        const failed = health.filter((h) => h.verdict.startsWith("FAILED")).length;
        const totalErrs = health.reduce((s, h) => s + h.errors, 0);
        const totalItems = health.reduce((s, h) => s + h.errorItems, 0);
        lines.push(`Health:    ${clean} clean · ${degen > 0 ? `⚠ ${degen} degenerate-win` : "0 degenerate-win"} · ${failed} failed  (${m.loops.length} loops; ${totalErrs} error rows, ${totalItems} minted error-items total)`);
        for (const workspace of m.workspaces) {
            lines.push("");
            lines.push(`## Workspace #${workspace.id} — ${workspace.name}`);
            lines.push("");
            lines.push(DigestRender.#cacheLine(m.requestsByWorkspace.get(workspace.id) ?? [], m));
            const workspaceWorkers = m.workersByWorkspace.get(workspace.id) ?? [];
            for (const worker of workspaceWorkers) {
                lines.push("");
                lines.push(`### Worker #${worker.id} — ${worker.name}`);
                lines.push(`Owner: ${worker.owner}`);
                lines.push("");
                lines.push("```");
                lines.push(DigestRender.#renderWorkerShape(worker, m));
                lines.push("```");
                const workerLoops = m.loopsByWorker.get(worker.id) ?? [];
                for (const loop of workerLoops) {
                    const terminal = DigestRender.#terminalResult(loop);
                    lines.push("");
                    const h = DigestRender.#loopHealth(loop, m);
                    const badge = h.verdict === "CLEAN"
                        ? " — CLEAN"
                        : ` — ${h.verdict === "DEGENERATE-WIN" ? "⚠ DEGENERATE-WIN" : h.verdict} (${h.errors} errors, ${h.errorItems} error-items)`;
                    lines.push(`#### Loop ${loop.sequence} (id=${loop.id}, status=${loop.status})${badge}`);
                    lines.push("");
                    if (loop.prompt.includes("\n")) {
                        lines.push("Prompt:\n" + DigestRender.#indentLines(loop.prompt.trimEnd(), "  "));
                    } else {
                        lines.push(`Prompt: ${loop.prompt}`);
                    }
                    const wake = DigestRender.#wakeLatency(loop, m);
                    if (wake !== null) lines.push(wake);
                    if (loop.status !== 200 && terminal?.problem?.detail !== undefined) {
                        lines.push(`Terminal${loop.terminated_by !== null ? ` (${loop.terminated_by})` : ""}: ${terminal.problem.detail.trim()}`);
                    }
                    lines.push("");
                    const turnLines = (m.turnsByLoop.get(loop.id) ?? []).map((t) => DigestRender.#renderTurnLine(t, m));
                    const findMaxTicks = (s: string): number => {
                        const matches = s.match(/`+/g);
                        return matches ? Math.max(...matches.map((match) => match.length)) : 0;
                    };
                    const maxBackticks = turnLines.reduce((max, line) => Math.max(max, findMaxTicks(line)), 0);
                    const fence = "`".repeat(Math.max(3, maxBackticks + 1));
                    lines.push(fence);
                    for (const line of turnLines) lines.push(line);
                    lines.push(fence);
                }
            }
        }
        return lines.join("\n");
    }

    static reasoning(m: DigestModel): string {
        const lines: string[] = [];
        lines.push(`# plurnk-service reasoning`);
        lines.push("");
        lines.push("Turn chronology with every provider attempt. Rejected attempts remain explicit forensic evidence.");
        for (const t of m.turns) {
            const loop = m.loopsById.get(t.loop_id);
            const worker = loop ? m.workersById.get(loop.worker_id) : undefined;
            lines.push("");
            lines.push(`## Worker ${worker?.id ?? "?"} / Loop ${loop?.sequence ?? "?"} / Turn ${t.sequence} (id=${t.id}, producer=${t.producer}, kind=${t.kind})`);
            if (t.kind !== "inference") {
                lines.push("");
                lines.push("(operation turn; no provider inference)");
                const reasoning = m.evidence.reasoning(t);
                if (reasoning !== null) lines.push("", reasoning);
                continue;
            }
            const attempts = m.attemptsByTurn.get(t.id) ?? [];
            if (attempts.length === 0) {
                const { packet, packetFailure } = m.evidence.packet(t);
                const reasoning = packet?.assistant != null
                    ? packet.assistant.reasoning
                    : null;
                lines.push("");
                if (packetFailure !== null) lines.push("(stored provider packet is invalid; see its packet artifacts)");
                else if (typeof reasoning === "string" && reasoning.length > 0) lines.push(reasoning);
                else lines.push("(no admitted provider reasoning)");
                continue;
            }
            for (const attempt of attempts) {
                const response = DigestRender.parseJson(m.evidence.response(attempt.model_call_id), {}) as {
                    assistant?: { reasoning?: unknown };
                };
                const parseErrors = DigestRender.parseJson(attempt.parse_errors, []) as Array<{ message?: unknown }>;
                lines.push("");
                const disposition = attempt.state === "error"
                    ? "call error"
                    : attempt.state === "pending"
                        ? "open at capture"
                        : attempt.accepted === 1
                            ? "admitted"
                            : "rejected";
                lines.push(`### Attempt ${attempt.sequence} - ${disposition}`);
                const attributions = DigestRender.parseJson(attempt.attributions, []) as unknown[];
                lines.push(`Attributions: ${attributions.length === 0 ? "(none)" : attributions.join(", ")}`);
                if (attempt.failure !== null) {
                    lines.push(`Failure: ${JSON.stringify(DigestRender.parseJson(attempt.failure, attempt.failure))}`);
                }
                for (const request of m.requestsByAttempt.get(attempt.id) ?? []) {
                    lines.push(`Physical request ${request.sequence}: [${request.state === "settled" ? request.outcome : request.state} evidence](requests/${request.id}.json)`);
                }
                if (attempt.accepted !== 1) {
                    for (const error of parseErrors) {
                        if (typeof error.message === "string") lines.push(`- ${error.message}`);
                    }
                    lines.push("");
                }
                const reasoning = response.assistant?.reasoning ?? null;
                if (typeof reasoning === "string" && reasoning.length > 0) lines.push(reasoning);
                else {
                    const reasoningTokens = DigestRender.#accounting(
                        m.requestsByAttempt.get(attempt.id) ?? [],
                    )?.usage?.outputTokenDetails?.reasoningTokens;
                    lines.push(reasoningTokens !== undefined && reasoningTokens > 0
                        ? `(provider reported ${reasoningTokens} reasoning tokens; no readable reasoning content returned)`
                        : attempt.state === "error" ? "(no admitted reasoning; partial output, when available, is in physical-request evidence)"
                            : "(no reasoning content returned)");
                }
            }
        }
        return lines.join("\n");
    }

    // {§share-packet-names}: render the owned envelope, never infer roles from filenames or body text.
    static request(messages: ReadonlyArray<ChatMessage & { content: string }>): string {
        const blocks = messages.map(({ role, content }, index) => {
            const length = [...content.matchAll(/`+/gu)].reduce((max, match) => Math.max(max, match[0].length + 1), 3);
            const fence = "`".repeat(length);
            return `## ${index + 1}. ${role}\n\n${fence}text\n${content}\n${fence}`;
        });
        return ["# Request", messages.map(({ role }) => role).join(" → "),
            "Stored text-message envelope, not a transport capture. Native payloads and provider transformations are not shown.",
            ...blocks, ""].join("\n\n");
    }

    // Per-turn forensic files. turnOps is the source authority; PacketWire
    // reproduces provider request slots, and assistantRaw preserves provider bytes.
    // {§share-packet-names}: the stem each turn's packet files carry is its log coordinate, worker, loop and
    // turn, as `log:///<loop>/<turn>/…` addresses it; a digest spanning workspaces nests one folder per
    // workspace. Shared with the turn lines so a reader never counts files by hand.
    static #stemCache = new WeakMap<DigestModel, Map<number, string>>();

    static packetStems(m: DigestModel): Map<number, string> {
        const cached = DigestRender.#stemCache.get(m);
        if (cached !== undefined) return cached;
        const nested = m.workspaces.length > 1;
        // {§share-packet-names} — a workspace is commonly named by a path (`~/ptl/x`), which cannot name a
        // file: the stem carries a slug of the name (#1001), the digest text keeps the name verbatim, and two
        // names that slug alike are told apart by the row's id.
        const slugged = new Map<string, number>();
        const segment = (name: string, id: number): string => {
            const slug = name.replace(/^~\//u, "").replace(/[^A-Za-z0-9_.-]+/gu, "-").replace(/^[^A-Za-z0-9_]+/u, "").replace(/-+$/u, "");
            const base = slug.length === 0 ? String(id) : slug;
            const owner = slugged.get(base);
            if (owner === undefined) { slugged.set(base, id); return base; }
            return owner === id ? base : `${base}-${id}`;
        };
        const stems = new Map<number, string>();
        const taken = new Set<string>();
        for (const turn of m.turns.filter((row) => row.has_packet === 1 || row.program !== null || row.has_reasoning === 1).toSorted((a, b) => a.id - b.id)) {
            const loop = m.loopsById.get(turn.loop_id);
            const worker = loop === undefined ? undefined : m.workersById.get(loop.worker_id);
            if (loop === undefined || worker === undefined) throw new TypeError(`digest: turn ${turn.id} has no loop or worker in scope`);
            const workspace = m.workspaces.find(({ id }) => id === worker.workspace_id);
            const stem = `${nested ? `${segment(workspace?.name ?? String(worker.workspace_id), worker.workspace_id)}/` : ""}${segment(worker.name, worker.id)}-${loop.sequence}-${turn.sequence}`;
            if (taken.has(stem)) throw new TypeError(`digest: two turns share the packet name ${stem}`);
            taken.add(stem);
            stems.set(turn.id, stem);
        }
        DigestRender.#stemCache.set(m, stems);
        return stems;
    }

    // Among its loop's model turns, this one's ordinal: the model's own count, which skips the
    // harness turns a reader would otherwise have to subtract.
    static #modelTurnOrdinal(turn: TurnRow, m: DigestModel): number | null {
        if (turn.producer !== "model") return null;
        const siblings = (m.turnsByLoop.get(turn.loop_id) ?? []).filter((t) => t.producer === "model");
        const index = siblings.findIndex((t) => t.id === turn.id);
        return index < 0 ? null : index + 1;
    }

    static packetFiles(m: DigestModel): string[] {
        const written: string[] = [];
        const stems = DigestRender.packetStems(m);
        const write = (file: string, body: string): void => {
            mkdirSync(dirname(join(m.digestDir, file)), { recursive: true });
            writeFileSync(join(m.digestDir, file), body);
            written.push(file);
        };
        m.turns
            .map((turn) => ({ turn, source: turn.program }))
            .filter(({ turn, source }) => turn.has_packet === 1 || source !== null || turn.has_reasoning === 1)
            .toSorted((a, b) => a.turn.id - b.turn.id)
            .forEach(({ turn, source }) => {
            const padded = stems.get(turn.id)!;
            const files: Array<[string, string]> = [];
            const { packet, packetFailure } = m.evidence.packet(turn);
            if (packetFailure !== null) {
                files.push(
                    [`${padded}.packet.raw.txt`, packetFailure.raw],
                    [`${padded}.packet.invalid.json`, JSON.stringify({
                        turnId: turn.id,
                        error: packetFailure.error,
                    }, null, 2)],
                );
            }
            if (packet !== null) {
                files.push(
                    [`${padded}.system.md`, packet.slot("system")],
                    [`${padded}.user.md`, packet.slot("user")],
                );
                // {§packet-wire-envelope} — the exact text messages the request carried; a stored packet
                // whose log cannot be projected is evidence of its own, never a reason to stop the digest.
                try {
                    const messages = packet.messages();
                    files.push(
                        [`${padded}.wire.json`, JSON.stringify(messages, null, 2)],
                        [`${padded}.request.md`, DigestRender.request(messages)],
                    );
                } catch (cause) {
                    files.push([`${padded}.wire.invalid.json`, JSON.stringify({ turnId: turn.id, error: cause instanceof Error ? cause.message : String(cause) }, null, 2)]);
                }
            }
            if (source !== null) {
                files.push([`${padded}.assistant.md`, source]);
            }
            const reasoning = m.evidence.reasoning(turn);
            if (reasoning !== null) files.push([`${padded}.reasoning.md`, reasoning]);
            if (packet?.assistant != null) {
                if (source !== null && packet.assistant.content !== source) {
                    throw new TypeError(`digest: turn ${turn.id} packet assistant differs from its turnOps source`);
                }
                files.push([`${padded}.assistantRaw.json`, JSON.stringify(packet.assistantRaw, null, 2)]);
            } else if (packet !== null) {
                files.push([
                    `${padded}.response.md`,
                    `# ${padded} — request only\n\nNo provider response was admitted. Rejected attempt evidence, when present, is written separately.\n`,
                ]);
            }
            for (const [file, body] of files) write(file, body);
            for (const attempt of m.attemptsByTurn.get(turn.id) ?? []) {
                if (attempt.accepted === 1) continue;
                const attemptPadded = String(attempt.sequence).padStart(3, "0");
                if (attempt.state !== "response") {
                    write(`${padded}.attempt${attemptPadded}.${attempt.state}.json`, JSON.stringify({
                        state: attempt.state,
                        failure: DigestRender.parseJson(attempt.failure),
                        attributions: DigestRender.parseJson(attempt.attributions, []),
                        openedAt: attempt.timestamp,
                        completedAt: attempt.completed_at,
                    }, null, 2));
                    continue;
                }
                const response = DigestRender.parseJson(m.evidence.response(attempt.model_call_id), {}) as {
                    assistant?: { content?: unknown };
                };
                const prefix = `${padded}.attempt${attemptPadded}.rejected`;
                const attemptFiles: Array<[string, string]> = [
                    [
                        `${prefix}.assistant.md`,
                        typeof response.assistant?.content === "string" ? response.assistant.content : "",
                    ],
                    [`${prefix}.response.json`, JSON.stringify(response, null, 2)],
                    [`${prefix}.parse-errors.json`, JSON.stringify(DigestRender.parseJson(attempt.parse_errors, []), null, 2)],
                    [`${prefix}.attributions.json`, JSON.stringify(DigestRender.parseJson(attempt.attributions, []), null, 2)],
                ];
                for (const [file, body] of attemptFiles) write(file, body);
            }
        });
        for (const request of m.providerRequests) {
            write(`requests/${request.id}.json`, JSON.stringify({
                id: request.id,
                inferenceCallId: request.inference_call_id,
                sequence: request.sequence,
                provider: request.provider,
                model: request.model,
                state: request.state,
                startedAt: request.started_at,
                completedAt: request.completed_at,
                accounting: request.state === "settled" ? DigestRender.#requestAccounting(request) : null,
                evidence: DigestRender.parseJson(m.evidence.request(request.id)),
            }, null, 2));
        }
        return written;
    }

    static *json(m: DigestModel): Generator<string> {
        const fields = {
            dbPath: m.dbPath,
            storage: m.storage,
            search: m.search,
            workspaces: m.workspaces.map((s) => ({
                id: s.id,
                name: s.name,
                accounting: DigestRender.#accounting(m.requestsByWorkspace.get(s.id) ?? []),
            })),
            workers: m.workers.map((r) => ({
                id: r.id,
                workspace_id: r.workspace_id,
                name: r.name,
                owner: r.owner,
                accounting: DigestRender.#accounting(m.requestsByWorker.get(r.id) ?? []),
                edit_census: DigestRender.#editCensus(m).byWorker.get(r.id) ?? null,
            })),
            loops: m.loops.map((l) => ({
                id: l.id, worker_id: l.worker_id, sequence: l.sequence, status: l.status,
                prompt: l.prompt,
                terminated_by: l.terminated_by,
                claimed_at: l.claimed_at,
                terminated_at: l.terminated_at,
                result: DigestRender.#terminalResult(l),
                accounting: DigestRender.#accounting(m.requestsByLoop.get(l.id) ?? []),
            })),
            turns: projectRows(m.turns, (t) => {
                const { packet, packetFailure } = m.evidence.packet(t);
                return {
                    id: t.id, loop_id: t.loop_id, sequence: t.sequence,
                    // {§share-packet-names}: the stem of this turn's packet files, or null when it wrote none.
                    artifact: DigestRender.packetStems(m).get(t.id) ?? null,
                    producer: t.producer, kind: t.kind,
                    program: t.program,
                    status: t.status, completed_at: t.completed_at,
                    accounting: DigestRender.#accounting(m.requestsByTurn.get(t.id) ?? []),
                    finish_reason: t.finish_reason, model: t.model,
                    attributions: packet?.attributions ?? [],
                    attachments: packet === null ? null : packet.attachments ?? [],
                    packet_failure: packetFailure,
                    // Preserve the opaque provider and engine metadata for aggregate
                    // tooling. {§meta-passthrough}, {§operator-grammar}
                    meta: DigestRender.parseJson(t.meta ?? "null", null),
                };
            }),
            inference_calls: m.inferenceCalls.map((call) => ({
                id: call.id,
                workspace_id: call.workspace_id,
                turn_id: call.turn_id,
                sequence: call.sequence,
                kind: call.kind,
                state: call.state,
                attributions: DigestRender.parseJson(call.attributions, []),
                request_model: call.request_model,
                accounting: DigestRender.#accounting(m.requestsByInferenceCall.get(call.id) ?? []),
                timestamp: call.timestamp,
                completed_at: call.completed_at,
            })),
            model_calls: projectRows(m.modelCalls, (call) => ({
                id: call.id,
                turn_id: call.turn_id,
                sequence: call.sequence,
                kind: call.kind,
                state: call.state,
                response: DigestRender.parseJson(m.evidence.response(call.id)),
                failure: DigestRender.parseJson(call.failure),
                attributions: DigestRender.parseJson(call.attributions, []),
                accounting: DigestRender.#accounting(m.requestsByInferenceCall.get(call.id) ?? []),
                finish_reason: call.finish_reason,
                model: call.model,
                request_model: call.request_model,
                response_model: call.response_model,
                timestamp: call.timestamp,
                completed_at: call.completed_at,
                turn_attempt_id: call.turn_attempt_id,
                accepted: call.accepted === null ? null : call.accepted === 1,
                parse_errors: DigestRender.parseJson(call.parse_errors, []),
                log_entry_id: call.log_entry_id,
            })),
            turn_attempts: projectRows(m.turnAttempts, (attempt) => ({
                id: attempt.id,
                turn_id: attempt.turn_id,
                sequence: attempt.sequence,
                state: attempt.state,
                accepted: attempt.accepted === null ? null : attempt.accepted === 1,
                response: DigestRender.parseJson(m.evidence.response(attempt.model_call_id)),
                failure: DigestRender.parseJson(attempt.failure),
                parse_errors: DigestRender.parseJson(attempt.parse_errors, []),
                attributions: DigestRender.parseJson(attempt.attributions, []),
                accounting: DigestRender.#accounting(m.requestsByAttempt.get(attempt.id) ?? []),
                finish_reason: attempt.finish_reason,
                model: attempt.model,
                timestamp: attempt.timestamp,
                completed_at: attempt.completed_at,
            })),
            provider_requests: m.providerRequests.map((request) => ({
                id: request.id,
                evidence: `requests/${request.id}.json`,
                inference_call_id: request.inference_call_id,
                turn_attempt_id: request.turn_attempt_id,
                kind: request.kind,
                sequence: request.sequence,
                state: request.state,
                accounting: request.state === "settled"
                    ? DigestRender.#requestAccounting(request)
                    : null,
                ...DigestRender.cacheLedger(m).get(request.id)!,
                started_at: request.started_at,
                completed_at: request.completed_at,
            })),
            log_entries: m.logEntries.map((le) => ({
                id: le.id, worker_id: le.worker_id, loop_id: le.loop_id,
                turn_id: le.turn_id, sequence: le.sequence, origin: le.origin,
                source: le.source, model_call_id: le.model_call_id,
                ...(le.inherited_history === undefined ? {} : { inherited_history: le.inherited_history === 1 }),
                ...(le.ambient_event_id === undefined ? {} : { ambient_event_id: le.ambient_event_id }),
                attrs: DigestRender.parseJson(le.attrs, {}),
                op: le.op, target: DigestRender.#renderTarget(le),
                status_rx: le.status_rx, state: le.state, outcome: le.outcome,
                initial_folded: DigestRender.parseJson(le.initial_folded, []),
                projection: {
                    active: le.projection_active === 1,
                    folded: DigestRender.parseJson(le.projection_folded, []),
                },
                ...(DigestRender.#renderStream(le) === null
                    ? {}
                    : { stream: DigestRender.#renderStream(le) }),
                ...(DigestRender.#environmentOf(le, m) === undefined ? {} : { env: DigestRender.#environmentOf(le, m) }),
                ...(le.status_rx >= 400 ? { problem: DigestRender.#rowProblem(le) } : {}),
                ...(DigestRender.#editCensus(m).formById.has(le.id)
                    ? { edit_form: DigestRender.#editCensus(m).formById.get(le.id), edit_revisit: DigestRender.#editCensus(m).revisitById.has(le.id) }
                    : {}),
            })),
            log_curation_effects: m.curationEffects.map(({ active_before, active_after, folded_before, folded_after, ...effect }) => ({
                ...effect,
                active_before: active_before === 1,
                active_after: active_after === 1,
                folded_before: DigestRender.parseJson(folded_before, []),
                folded_after: DigestRender.parseJson(folded_after, []),
            })),
        };
        yield "{";
        let fieldSeparator = "";
        for (const [name, value] of Object.entries(fields)) {
            yield `${fieldSeparator}\n  ${JSON.stringify(name)}: `;
            if (typeof value === "object" && value !== null && Symbol.iterator in value) {
                yield "[";
                let itemSeparator = "";
                for (const row of value as Iterable<unknown>) {
                    yield `${itemSeparator}\n${JSON.stringify(row, null, 2).replace(/^/gm, "    ")}`;
                    itemSeparator = ",";
                }
                yield itemSeparator === "" ? "]" : "\n  ]";
            } else {
                yield JSON.stringify(value, null, 2);
            }
            fieldSeparator = ",";
        }
        yield "\n}\n";
    }
}
