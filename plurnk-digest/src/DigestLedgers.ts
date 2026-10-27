import { isRecord } from "@plurnk/plurnk-contracts";
import { parseJson } from "./DigestFormat.ts";
import {
    EDIT_FORMS,
    type CacheLedgerEntry,
    type DigestModel,
    type EditCensus,
    type EditForm,
    type EditRow,
    type LogRow,
    type LoopRow,
    type ProviderRequestRow,
    type SessionRow,
    type TurnRow,
} from "./digest-rows.ts";

// {§digest-forensic-fidelity} (#436) — a failed command's completion rows carry the
// executor's problem identity; a red test run is the loop's normal work, not a
// defect. They stay visible but never count as errors in health or the errs
// badge — the digest mirror of the strike rail's exemption (#425 F1).
const isExecutorEvidence = (le: LogRow): boolean => {
    if (le.status_rx < 400 || le.rx === null) return false;
    const rx = parseJson(le.rx, null);
    const problem = isRecord(rx) && isRecord(rx.problem) ? rx.problem : null;
    return typeof problem?.type === "string" && problem.type.startsWith("https://problems.plurnk.xyz/executor/");
};

// {§digest-forensic-fidelity} (#1096) — a 413 is the capacity contract working: a result that did
// not fit, the over-budget mandate, a limit met. It renders like any row and never counts as an
// error, an error item or in the errs badge; a loop that concluded under a binding budget is CLEAN.
export const isCapacityEvidence = (le: LogRow): boolean => le.status_rx === 413;

export const countsAsError = (le: LogRow): boolean =>
    le.status_rx >= 400 && !isExecutorEvidence(le) && !isCapacityEvidence(le);

export const loopHealth = (loop: LoopRow, m: DigestModel): { errors: number; errorItems: number; verdict: string } => {
    let errors = 0;
    let errorItems = 0;
    for (const t of m.turnsByLoop.get(loop.id) ?? []) {
        for (const le of m.logEntriesByTurn.get(t.id) ?? []) {
            if (countsAsError(le)) errors += 1;
            if (le.op === "error" && !isCapacityEvidence(le)) errorItems += 1;
        }
    }
    const s = loop.status;
    const verdict = s >= 400 ? `FAILED(${s})`
        : s >= 200 && s < 300 ? (errors > 0 ? "DEGENERATE-WIN" : "CLEAN")
        : `status=${s}`;
    return { errors, errorItems, verdict };
};

// {§digest-forensic-fidelity} — the reconstructed text envelope, each role above its content,
// as `.wire.json` holds it ({§share-packet-names}); null when no valid packet is stored.
const promptText = (turn: TurnRow, m: DigestModel): string | null => {
    const { packet } = m.evidence.packet(turn);
    if (packet === null) return null;
    const messages = packet.messages();
    if (messages.length === 0) return null;
    return messages
        .map(({ role, content }) => `${role}\n${content}`)
        .join("\n");
};

const commonPrefixLength = (left: string, right: string): number => {
    const bound = Math.min(left.length, right.length);
    let n = 0;
    while (n < bound && left.charCodeAt(n) === right.charCodeAt(n)) n += 1;
    return n;
};

// {§digest-forensic-fidelity}: the form an EDIT authored, read from its stored marker and pattern.
export const editForm = (row: Pick<EditRow, "line_marker" | "pattern">): EditForm => {
    if (row.pattern !== null) return "pattern";
    if (row.line_marker === null) return "whole";
    const marker = parseJson(row.line_marker, { marks: [] });
    const marks: readonly unknown[] = isRecord(marker) && Array.isArray(marker.marks) ? marker.marks : [];
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
};

const editCensusCache = new WeakMap<DigestModel, { bySession: Map<number, EditCensus>; formById: Map<number, EditForm>; revisitById: Set<number> }>();

// {§digest-forensic-fidelity}: per session, every model EDIT by authored form and status, and the
// revisits — an EDIT of a path the same session edited within its previous two model turns.
export const editCensus = (m: DigestModel): { bySession: Map<number, EditCensus>; formById: Map<number, EditForm>; revisitById: Set<number> } => {
    const cached = editCensusCache.get(m);
    if (cached !== undefined) return cached;
    const loopSession = new Map(m.loops.map((loop) => [loop.id, loop.session_id]));
    // A session's model turns in order; the ordinal is the distance the revisit window counts in.
    const ordinal = new Map<number, number>();
    const perSession = new Map<number, number>();
    for (const turn of [...m.turns].toSorted((a, b) => a.id - b.id)) {
        if (turn.producer !== "model") continue;
        const sessionId = loopSession.get(turn.loop_id);
        if (sessionId === undefined) throw new TypeError(`turn ${turn.id} has no loop in scope`);
        const next = (perSession.get(sessionId) ?? 0) + 1;
        perSession.set(sessionId, next);
        ordinal.set(turn.id, next);
    }
    const bySession = new Map<number, EditCensus>();
    const formById = new Map<number, EditForm>();
    const revisitById = new Set<number>();
    for (const [sessionId, rows] of m.editRowsBySession) {
        const census: EditCensus = { edits: 0, refused: 0, revisits: 0, forms: Object.fromEntries(EDIT_FORMS.map((form) => [form, 0])) };
        const lastEdited = new Map<string, number>();
        for (const row of rows) {
            const form = editForm(row);
            formById.set(row.id, form);
            census.edits += 1;
            census.forms[form] = (census.forms[form] ?? 0) + 1;
            if (row.status_rx >= 400) census.refused += 1;
            const at = ordinal.get(row.turn_id);
            if (at === undefined) throw new TypeError(`EDIT ${row.id} sits on a turn no model produced`);
            if (row.pathname !== null) {
                const previous = lastEdited.get(row.pathname);
                if (previous !== undefined && previous < at && at - previous <= 2) { census.revisits += 1; revisitById.add(row.id); }
                lastEdited.set(row.pathname, at);
            }
        }
        bySession.set(sessionId, census);
    }
    const result = { bySession, formById, revisitById };
    editCensusCache.set(m, result);
    return result;
};

export const renderEditCensus = (census: EditCensus | undefined): string => {
    if (census === undefined || census.edits === 0) return "(no edits)";
    const forms = EDIT_FORMS.filter((form) => (census.forms[form] ?? 0) > 0).map((form) => `${form}=${census.forms[form] ?? 0}`).join(" ");
    return `${census.edits} · ${forms} · refused=${census.refused} · revisits=${census.revisits}`;
};

const cacheLedgerCache = new WeakMap<DigestModel, Map<number, CacheLedgerEntry>>();

// {§digest-forensic-fidelity} — estimate adjacent prefixes with at most two prompts resident per loop.
export const cacheLedger = (m: DigestModel): Map<number, CacheLedgerEntry> => {
    const cached = cacheLedgerCache.get(m);
    if (cached !== undefined) return cached;
    const turnsById = new Map(m.turns.map((turn) => [turn.id, turn]));
    const ledger = new Map<number, CacheLedgerEntry>();
    for (const loop of m.loops) {
        let memo: { turnId: number; text: string | null } | undefined;
        const promptOf = (turn: TurnRow): string | null => {
            if (memo?.turnId !== turn.id) memo = { turnId: turn.id, text: promptText(turn, m) };
            return memo.text;
        };
        // undefined: no previous request in this loop; null: the previous request's packet is not valid.
        let previousText: string | null | undefined;
        for (const request of m.requestsByLoop.get(loop.id) ?? []) {
            const turn = turnsById.get(request.turn_id);
            if (turn === undefined) throw new TypeError(`provider request ${request.id} has no turn in scope`);
            const text = request.kind === "emission" ? promptOf(turn) : null;
            const adjacentPrefixTokensEstimate = text === null || request.usage_input === null
                ? null
                : previousText === undefined
                    ? 0
                    : previousText === null
                        ? null
                        : text.length === 0
                            ? 0
                            : Math.round(request.usage_input * m.evidence.textWeight(text.slice(0, commonPrefixLength(previousText, text))) / m.evidence.textWeight(text));
            ledger.set(request.id, {
                adjacentPrefixTokensEstimate,
                cachedTokens: request.usage_input_cache_read,
                inputTokens: request.usage_input,
            });
            previousText = text;
        }
    }
    for (const request of m.providerRequests) {
        if (!ledger.has(request.id)) throw new TypeError(`provider request ${request.id} has no loop in scope`);
    }
    cacheLedgerCache.set(m, ledger);
    return ledger;
};

const cacheEntries = (requests: readonly ProviderRequestRow[], m: DigestModel): CacheLedgerEntry[] => {
    const ledger = cacheLedger(m);
    return requests.map((request) => ledger.get(request.id)!);
};

// {§digest-forensic-fidelity} — sum each provider-reported counter; one absent quantity makes that sum unknown.
export const cacheBadge = (turn: TurnRow, m: DigestModel): string => {
    const entries = cacheEntries(m.requestsByTurn.get(turn.id) ?? [], m);
    if (entries.length === 0) return "";
    const sum = (values: Array<number | null>): string => values.some((value) => value === null)
        ? "?"
        : String(values.reduce<number>((total, value) => total + (value ?? 0), 0));
    return ` cache=${sum(entries.map((entry) => entry.cachedTokens))}/${sum(entries.map((entry) => entry.inputTokens))}`;
};

// {§digest-forensic-fidelity} — one workspace line; unreported requests are named and left out of the percentage.
export const cacheLine = (requests: readonly ProviderRequestRow[], m: DigestModel): string => {
    const entries = cacheEntries(requests, m);
    const reported = entries.filter((entry) => entry.cachedTokens !== null && entry.inputTokens !== null);
    const unreported = entries.length - reported.length;
    const cached = reported.reduce((total, entry) => total + (entry.cachedTokens ?? 0), 0);
    const input = reported.reduce((total, entry) => total + (entry.inputTokens ?? 0), 0);
    const pct = input === 0 ? "n/a" : `${((100 * cached) / input).toFixed(1)}%`;
    const plural = (n: number): string => n === 1 ? "request" : "requests";
    return [
        `Cache: ${cached} of ${input} reported input tokens read from cache (${pct}) over ${reported.length} ${plural(reported.length)}`,
        unreported > 0 ? `${unreported} missing input or cache usage (excluded)` : null,
    ].filter((part) => part !== null).join(" · ");
};

// One measure per packet-bearing inference turn whose request records a known capacity and wall and a
// provider count: the exact preflight measurement, else the reported input.
const roomMeasures = (session: SessionRow, m: DigestModel): Array<{ weight: number; budget: number; capacity: number; wall: number; count: number; estimate: number }> => {
    const measures = [];
    for (const loop of m.loopsBySession.get(session.id) ?? []) {
        for (const turn of m.turnsByLoop.get(loop.id) ?? []) {
            if (turn.kind !== "inference" || turn.has_packet !== 1) continue;
            const packet = m.evidence.packet(turn).packet;
            if (packet === null || packet.budget === null || packet.budget === 0 || packet.weight === 0) continue;
            const call = m.modelCalls.findLast((row) => row.turn_id === turn.id && row.kind === "emission" && row.capacity !== null);
            const capacity = parseJson(call?.capacity);
            const inputCapacity = isRecord(capacity) ? capacity.inputCapacity : undefined;
            const inputWall = isRecord(capacity) ? capacity.inputWall : undefined;
            if (typeof inputCapacity !== "number" || typeof inputWall !== "number") continue;
            const reported = (m.requestsByTurn.get(turn.id) ?? [])
                .findLast((row) => row.kind === "emission" && row.outcome === "response" && row.usage_input !== null)?.usage_input ?? null;
            const prompt = isRecord(capacity) && isRecord(capacity.prompt) ? capacity.prompt : null;
            const count = prompt?.kind === "exact" ? (typeof prompt.tokens === "number" ? prompt.tokens : null) : reported;
            if (count === null || count === 0) continue;
            measures.push({
                weight: packet.weight, budget: packet.budget, capacity: inputCapacity, wall: inputWall, count,
                estimate: Math.ceil(packet.weight * inputCapacity / packet.budget),
            });
        }
    }
    return measures;
};

// {§digest-forensic-fidelity} — the room in provider tokens: the largest budget the model was shown, at its
// request's own ratio, against the capacity; the wall's estimate against the provider's count; and the
// requests the estimate put under the wall while the count was over it.
export const renderRoom = (session: SessionRow, m: DigestModel): string => {
    const measured = roomMeasures(session, m);
    if (measured.length === 0) return "(no measured requests)";
    const room = Math.max(...measured.map(({ weight, budget, count, capacity }) => budget * count / weight / capacity));
    const errors = measured.map(({ estimate, count }) => (estimate - count) / count);
    const missed = measured.filter(({ estimate, count, wall }) => estimate <= wall && count > wall).length;
    const percent = (ratio: number): string => `${ratio < 0 ? "-" : "+"}${Math.abs(100 * ratio).toFixed(1)}%`;
    return `budget up to ${Math.round(100 * room)}% of capacity · wall estimate ${percent(Math.min(...errors))} to ${percent(Math.max(...errors))} of the count`
        + (missed === 0 ? "" : `  ⚠ ${missed} over the wall the estimate admitted`);
};

// {§turn-source-resources} — announced, retired by the model, and echoed back as headings in its own text.
export const renderEmissions = (session: SessionRow, m: DigestModel): string => {
    const rows = m.emissionRows.filter((row) => row.session_id === session.id);
    const killed = rows.filter((row) => row.active === 0).length;
    const echoes = (m.loopsBySession.get(session.id) ?? [])
        .flatMap((loop) => m.turnsByLoop.get(loop.id) ?? [])
        .reduce((sum, turn) => sum + turn.packetEchoes, 0);
    return `${rows.length} announced · ${killed} killed · ${echoes} header echo${echoes === 1 ? "" : "es"}`;
};

// {§turn-source-resources} — landed, retired by the model, and turns that reasoned.
export const renderReasonings = (session: SessionRow, m: DigestModel): string => {
    const rows = m.reasoningRows.filter((row) => row.session_id === session.id);
    const killed = rows.filter((row) => row.active === 0).length;
    const reasonedTurns = (m.loopsBySession.get(session.id) ?? [])
        .flatMap((loop) => m.turnsByLoop.get(loop.id) ?? [])
        .filter((turn) => turn.has_reasoning === 1).length;
    if (reasonedTurns === 0 && rows.length === 0) return "(no reasoning)";
    if (rows.length === 0) return `0 of ${reasonedTurns} landed (unbudgeted or disabled)`;
    if (reasonedTurns > rows.length) return `${rows.length} of ${reasonedTurns} landed · ${killed} killed`;
    return `${rows.length} landed · ${killed} killed`;
};
