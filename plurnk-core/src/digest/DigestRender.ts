// Digest renderers ({§digest-programmatic-surface}): the markdown, JSON, reasoning, and packet
// artifacts of one DigestModel. Pure projection of the model — no DB, no I/O except packetFiles.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import PacketWire from "../core/packet-wire.ts";
import LogBody from "../core/LogBody.ts";
import StoredPacket from "../core/StoredPacket.ts";
import { renderTarget } from "../core/plurnk-uri.ts";
import EntryManifest from "../schemes/_entry-manifest.ts";
import {
    aggregateProviderAccounting,
    type ProviderAccounting,
    type ProviderRequestAccounting,
} from "@plurnk/plurnk-providers";
import {
    providerRequestFromStorageRow,
    type ProviderRequestStorageRow,
} from "../core/provider-accounting.ts";
import { Validator, type OperationResult, type ProblemDetails } from "@plurnk/plurnk-contracts";
import type {
    WorkerRow,
    LoopRow,
    TurnRow,
    ProviderRequestRow,
    LogRow,
    DigestModel,
} from "./digest-rows.ts";

export default class DigestRender {
    static #summarize(text: unknown, n = 80): string {
        if (text === null || text === undefined) return "";
        const flat = String(text).replace(/\s+/g, " ").trim();
        if (flat.length <= n) return flat;
        return `${flat.slice(0, n)}…`;
    }

    static parseJson(s: unknown, fallback: unknown = null): unknown {
        if (s === null || s === undefined) return fallback;
        try { return JSON.parse(String(s)); } catch { return fallback; }
    }

    static #requestAccounting(row: ProviderRequestRow): ProviderRequestAccounting {
        if (row.state !== "settled" || row.outcome === null || row.cost_kind === null) {
            throw new TypeError(`digest: provider request ${row.id} is not settled`);
        }
        return providerRequestFromStorageRow(row as ProviderRequestStorageRow);
    }

    static #accounting(rows: readonly ProviderRequestRow[]): ProviderAccounting | null {
        return rows.some((row) => row.state !== "settled")
            ? null
            : aggregateProviderAccounting(rows.map((row) => DigestRender.#requestAccounting(row)));
    }

    static usageSummary(accounting: ProviderAccounting | null): string {
        if (accounting === null) return "accounting=incomplete";
        const usage = accounting.usage;
        return [
            `input=${usage?.inputTokens ?? "unknown"}`,
            `output=${usage?.outputTokens ?? "unknown"}`,
            `reasoning=${usage?.outputTokenDetails?.reasoningTokens ?? "unknown"}`,
            `cache-read=${usage?.inputTokenDetails?.cacheReadTokens ?? "unknown"}`,
        ].join(" ");
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
        return renderTarget(le);
    }

    static #renderStream(le: LogRow): string | null {
        if (le.op !== "EXEC") return null;
        const stream = (DigestRender.parseJson(le.attrs, {}) as { stream?: unknown }).stream;
        return typeof stream === "string" ? stream : null;
    }

    static #renderOpLine(le: LogRow, label: string = le.op ?? "source artifact"): string {
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
            errLine = `\n    -> ${DigestRender.#summarize(DigestRender.#rowProblem(le).detail, 140)}`;
        }
        return `  ← [${le.origin}] ${label}[${le.status_rx}] ${target}${source}${state}${outcome}${streamLink}${fail}${errLine}`;
    }

    static #renderGroupedOpLine(row: LogRow): string {
        const attrs = DigestRender.parseJson(row.attrs, {}) as { kind?: unknown };
        const materialized = row.origin === "_plurnk" && row.op === "EDIT" && attrs.kind === "entry_materialized";
        const actionlessKind = row.op === null
            ? LogBody.actionlessKind({ op: row.op, attrs })
            : null;
        const label = actionlessKind === "emissionAttempt"
            ? "emission attempt"
            : actionlessKind ?? row.op ?? "actionless row";
        return DigestRender.#renderOpLine(row, materialized ? "materialized entry" : label);
    }

    // Human triage is not a row dump. Preserve every row in digest.json, but
    // collapse identical rendered outcomes in the Markdown waterfall. Using the
    // rendered line itself as the key keeps actor, complete target, lifecycle,
    // stream, and visible failure detail structurally aligned with the grouping.
    static #renderOpLines(rows: LogRow[]): string[] {
        const groups = new Map<string, { line: string; count: number; firstSeq: number; lastSeq: number }>();
        for (const row of rows) {
            const line = DigestRender.#renderGroupedOpLine(row);
            const group = groups.get(line);
            if (group === undefined) {
                groups.set(line, { line, count: 1, firstSeq: row.sequence, lastSeq: row.sequence });
            } else {
                group.count++;
                group.lastSeq = row.sequence;
            }
        }
        return [...groups.values()].map(({ line, count, firstSeq, lastSeq }) => {
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
        const packet = turn.packet;
        const assistant = packet !== null && StoredPacket.isAdmitted(packet) ? packet.assistant : null;
        const content = assistant?.content ?? "";
        const reasoning = assistant?.reasoning ?? null;
        const accounting = DigestRender.#accounting(m.requestsByTurn.get(turn.id) ?? []);
        const tokens = DigestRender.usageSummary(accounting);
        const cost = accounting === null || accounting.costUsd === null
            ? " cost=unavailable"
            : ` cost=$${accounting.costUsd}`;
        const finishReason = turn.finish_reason ?? "—";
        // Render only observed constraint metadata; absence makes no claim
        // about endpoint-owned settings. {§rail-truth-engine-verdict}
        const tm = DigestRender.parseJson(turn.meta ?? "null", null) as { railsAttached?: boolean | string; railsVerdict?: string } | null;
        const attached = tm?.railsAttached;
        const rails = attached === undefined || attached === false ? ""
            : ` rails=${attached === true ? "client" : attached}:${tm?.railsVerdict ?? "attached"}`;
        const model = turn.model ?? "—";
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
        const packetBadge = turn.packetFailure === null ? "" : "  ⚠ packet=invalid";
        const lifecycle = `T${turn.sequence}: producer=${turn.producer} kind=${turn.kind} status=${turn.status}${turn.completed_at === null ? " state=open" : ""}`;
        const head = turn.kind === "inference"
            ? `${lifecycle} finish=${finishReason}${rails} model=${model} ${tokens}${cost}${errBadge}${attemptBadge}${packetBadge}`
            : `${lifecycle}${errBadge}${packetBadge}`;
        const summary = turn.packetFailure !== null
            ? `  ↳ provider packet: invalid stored evidence (${turn.packetFailure.error.message})`
            : packet === null
            ? null
            : content.length > 0
            ? `  ↳ emission: ${DigestRender.#summarize(content, 100)}`
            : assistant !== null
            ? "  ↳ emission: (admitted empty)"
            : rejected > 0
            ? `  ↳ emission: (none admitted; ${rejected} rejected)`
            : "  ↳ emission: (none admitted)";
        const reasoningLine = reasoning && reasoning.length > 0
            ? `  ↳ reasoning: ${DigestRender.#summarize(reasoning, 100)}`
            : null;
        const opLines = DigestRender.#renderOpLines(m.logEntriesByTurn.get(turn.id) ?? []);
        return [head, ...(summary ? [summary] : []), ...(reasoningLine ? [reasoningLine] : []), ...opLines].join("\n");
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
            : accounting === null || accounting.costUsd === null
                ? "unknown"
                : `$${accounting.costUsd}`;
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
            `Op mix:     ${opMix.length > 0 ? opMix : "(no ops)"}`,
        ].join("\n");
    }

    static waterfall(m: DigestModel): string {
        const lines: string[] = [];
        lines.push(`# plurnk-service digest`);
        lines.push("");
        lines.push(`DB: ${m.dbPath}`);
        const rejectedAttempts = m.turnAttempts.filter((attempt) => attempt.accepted === 0).length;
        const erroredCalls = m.inferenceCalls.filter((call) => call.state === "error").length;
        const pendingCalls = m.inferenceCalls.filter((call) => call.state === "pending").length;
        const bareCalls = m.modelCalls.filter((call) => call.kind === "bare").length;
        const embeddingCalls = m.embeddingCalls.length;
        const pendingRequests = m.providerRequests.filter((request) => request.state === "pending").length;
        const packetFailures = m.turns.filter((turn) => turn.packetFailure !== null).length;
        lines.push(`Workspaces: ${m.workspaces.length}  Workers: ${m.workers.length}  Loops: ${m.loops.length}  Turns: ${m.turns.length}  Inference calls: ${m.inferenceCalls.length} (${bareCalls} BARE, ${embeddingCalls} embedding, ${erroredCalls} errored, ${pendingCalls} open)  Emission attempts: ${m.turnAttempts.length} (${rejectedAttempts} rejected)  Provider requests: ${m.providerRequests.length} (${pendingRequests} open)  Log entries: ${m.logEntries.length}`);
        if (packetFailures > 0) lines.push(`Stored packet failures: ${packetFailures}`);
        lines.push(`Semantic:  channels=${m.embeddings.channel_entries} attached=${m.embeddings.derivation_complete} (vector=${m.embeddings.vector_complete} lexical=${m.embeddings.lexical} excluded=${m.embeddings.excluded} nonsemantic=${m.embeddings.nonsemantic} failed=${m.embeddings.failed}) unattached=${m.embeddings.unfinished} artifacts=${m.embeddings.derivation_artifacts_complete} complete/${m.embeddings.derivation_artifacts_building} building chunks=${m.embeddings.chunk_rows} models=${m.embeddings.models} token-derivations=${m.embeddings.token_derivations}`);
        if (m.embeddings.dispositions.length > 0) {
            lines.push("Semantic dispositions:");
            for (const row of m.embeddings.dispositions) {
                const address = `${EntryManifest.toPath(row.scheme, row.authority, row.pathname)}#${row.channel}`;
                lines.push(`  ${row.disposition} ${address}${row.reason === null ? "" : ` — ${row.reason}`}`);
            }
        }
        // Triage rollup up top: how many conversations limped vs died vs ran clean, and the total
        // error/strike load. The whole point of the "degenerate win" lens — see it before scrolling.
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
            const workspaceWorkers = m.workersByWorkspace.get(workspace.id) ?? [];
            for (const worker of workspaceWorkers) {
                lines.push("");
                lines.push(`### Worker #${worker.id} — ${worker.name}`);
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
                    lines.push(`Prompt: ${DigestRender.#summarize(loop.prompt, 160)}`);
                    if (loop.status !== 200 && terminal?.problem?.detail !== undefined) {
                        lines.push(`Terminal${loop.terminated_by !== null ? ` (${loop.terminated_by})` : ""}: ${DigestRender.#summarize(terminal.problem.detail, 400)}`);
                    }
                    const policy = DigestRender.parseJson(loop.policy, {}) as Record<string, unknown>;
                    const policySummary = Object.entries(policy)
                        .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
                        .join(" ");
                    if (policySummary.length > 0) lines.push(`Policy: ${policySummary}`);
                    lines.push("");
                    lines.push("```");
                    for (const t of m.turnsByLoop.get(loop.id) ?? []) lines.push(DigestRender.#renderTurnLine(t, m));
                    lines.push("```");
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
                continue;
            }
            const attempts = m.attemptsByTurn.get(t.id) ?? [];
            if (attempts.length === 0) {
                const reasoning = t.packet !== null && StoredPacket.isAdmitted(t.packet)
                    ? t.packet.assistant.reasoning
                    : null;
                lines.push("");
                if (t.packetFailure !== null) lines.push("(stored provider packet is invalid; see its packet artifacts)");
                else if (typeof reasoning === "string" && reasoning.length > 0) lines.push(reasoning);
                else lines.push("(no admitted provider reasoning)");
                continue;
            }
            for (const attempt of attempts) {
                const response = DigestRender.parseJson(attempt.response, {}) as {
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
                        : "(no reasoning content returned)");
                }
            }
        }
        return lines.join("\n");
    }

    static #turnOpsSource(m: DigestModel, turn: TurnRow): string | null {
        const rows = (m.logEntriesByTurn.get(turn.id) ?? []).filter((row) =>
            row.op === null
            && LogBody.actionlessKind({ op: row.op, attrs: row.attrs }) === "turnOps");
        if (rows.length > 1) {
            throw new TypeError(`digest: turn ${turn.id} has ${rows.length} turnOps rows; expected at most one`);
        }
        const row = rows[0];
        if (row === undefined) return null;
        const body = LogBody.resolve({
            op: row.op,
            attrs: row.attrs,
            tx: null,
            rx: row.rx,
            mimetypeRx: row.mimetype_rx,
        });
        if (body.mimetype !== "text/vnd.plurnk") {
            throw new TypeError(`digest: turn ${turn.id} turnOps has mimetype ${JSON.stringify(body.mimetype)}; expected text/vnd.plurnk`);
        }
        return body.content;
    }

    // Per-turn forensic files. turnOps is the source authority; PacketWire
    // reproduces provider request slots, and assistantRaw preserves provider bytes.
    static packetFiles(m: DigestModel): string[] {
        const written: string[] = [];
        m.turns
            .map((turn) => ({ turn, source: DigestRender.#turnOpsSource(m, turn) }))
            .filter(({ turn, source }) => turn.packet !== null || turn.packetFailure !== null || source !== null)
            .toSorted((a, b) => a.turn.id - b.turn.id)
            .forEach(({ turn, source }, ordinal) => {
            const padded = String(ordinal).padStart(3, "0");
            const files: Array<[string, string]> = [];
            const packet = turn.packet;
            if (turn.packetFailure !== null) {
                files.push(
                    [`packet${padded}.packet.raw.txt`, turn.packetFailure.raw],
                    [`packet${padded}.packet.invalid.json`, JSON.stringify({
                        turnId: turn.id,
                        error: turn.packetFailure.error,
                    }, null, 2)],
                );
            }
            if (packet !== null) {
                files.push(
                    [`packet${padded}.system.md`, PacketWire.renderSlot(packet.sections, "system")],
                    [`packet${padded}.user.md`, PacketWire.renderSlot(packet.sections, "user")],
                );
            }
            if (source !== null) {
                files.push([`packet${padded}.assistant.md`, source]);
            }
            if (packet !== null && StoredPacket.isAdmitted(packet)) {
                if (source !== null && packet.assistant.content !== source) {
                    throw new TypeError(`digest: turn ${turn.id} packet assistant differs from its turnOps source`);
                }
                files.push([`packet${padded}.assistantRaw.json`, JSON.stringify(packet.assistantRaw, null, 2)]);
            } else if (packet !== null) {
                files.push([
                    `packet${padded}.response.md`,
                    `# Packet ${ordinal} — request only\n\nNo provider response was admitted. Rejected attempt evidence, when present, is written separately.\n`,
                ]);
            }
            for (const [file, body] of files) {
                writeFileSync(join(m.digestDir, file), body);
                written.push(file);
            }
            for (const attempt of m.attemptsByTurn.get(turn.id) ?? []) {
                if (attempt.accepted === 1) continue;
                const attemptPadded = String(attempt.sequence).padStart(3, "0");
                if (attempt.state !== "response") {
                    const file = `packet${padded}.attempt${attemptPadded}.${attempt.state}.json`;
                    writeFileSync(join(m.digestDir, file), JSON.stringify({
                        state: attempt.state,
                        failure: DigestRender.parseJson(attempt.failure),
                        attributions: DigestRender.parseJson(attempt.attributions, []),
                        openedAt: attempt.timestamp,
                        completedAt: attempt.completed_at,
                    }, null, 2));
                    written.push(file);
                    continue;
                }
                const response = DigestRender.parseJson(attempt.response, {}) as {
                    assistant?: { content?: unknown };
                };
                const prefix = `packet${padded}.attempt${attemptPadded}.rejected`;
                const attemptFiles: Array<[string, string]> = [
                    [
                        `${prefix}.assistant.md`,
                        typeof response.assistant?.content === "string" ? response.assistant.content : "",
                    ],
                    [`${prefix}.response.json`, JSON.stringify(response, null, 2)],
                    [`${prefix}.parse-errors.json`, JSON.stringify(DigestRender.parseJson(attempt.parse_errors, []), null, 2)],
                    [`${prefix}.attributions.json`, JSON.stringify(DigestRender.parseJson(attempt.attributions, []), null, 2)],
                ];
                for (const [file, body] of attemptFiles) {
                    writeFileSync(join(m.digestDir, file), body);
                    written.push(file);
                }
            }
        });
        return written;
    }

    static json(m: DigestModel): string {
        return JSON.stringify({
            dbPath: m.dbPath,
            semantic: m.embeddings,
            workspaces: m.workspaces.map((s) => ({
                id: s.id,
                name: s.name,
                accounting: DigestRender.#accounting(m.requestsByWorkspace.get(s.id) ?? []),
            })),
            workers: m.workers.map((r) => ({
                id: r.id,
                workspace_id: r.workspace_id,
                name: r.name,
                accounting: DigestRender.#accounting(m.requestsByWorker.get(r.id) ?? []),
            })),
            loops: m.loops.map((l) => ({
                id: l.id, worker_id: l.worker_id, sequence: l.sequence, status: l.status,
                prompt: l.prompt, policy: DigestRender.parseJson(l.policy, {}),
                terminated_by: l.terminated_by,
                result: DigestRender.#terminalResult(l),
                accounting: DigestRender.#accounting(m.requestsByLoop.get(l.id) ?? []),
            })),
            turns: m.turns.map((t) => ({
                id: t.id, loop_id: t.loop_id, sequence: t.sequence,
                producer: t.producer, kind: t.kind,
                status: t.status, completed_at: t.completed_at,
                accounting: DigestRender.#accounting(m.requestsByTurn.get(t.id) ?? []),
                finish_reason: t.finish_reason, model: t.model,
                attributions: t.packet?.attributions ?? [],
                attachments: t.packet === null ? null : t.packet.attachments ?? [],
                packet_failure: t.packetFailure,
                // Preserve the opaque provider and engine metadata for aggregate
                // tooling. {§meta-passthrough}, {§rail-truth-engine-verdict}
                meta: DigestRender.parseJson(t.meta ?? "null", null),
            })),
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
            model_calls: m.modelCalls.map((call) => ({
                id: call.id,
                turn_id: call.turn_id,
                sequence: call.sequence,
                kind: call.kind,
                state: call.state,
                response: DigestRender.parseJson(call.response),
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
            embedding_calls: m.embeddingCalls.map((call) => ({
                id: call.id,
                workspace_id: call.workspace_id,
                turn_id: call.turn_id,
                sequence: call.sequence,
                kind: call.kind,
                state: call.state,
                model: call.model,
                input_count: call.input_count,
                output_count: call.output_count,
                metadata: DigestRender.parseJson(call.metadata),
                failure: DigestRender.parseJson(call.failure),
                accounting: DigestRender.#accounting(m.requestsByInferenceCall.get(call.id) ?? []),
                timestamp: call.timestamp,
                completed_at: call.completed_at,
            })),
            turn_attempts: m.turnAttempts.map((attempt) => ({
                id: attempt.id,
                turn_id: attempt.turn_id,
                sequence: attempt.sequence,
                state: attempt.state,
                accepted: attempt.accepted === null ? null : attempt.accepted === 1,
                response: DigestRender.parseJson(attempt.response),
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
                inference_call_id: request.inference_call_id,
                turn_attempt_id: request.turn_attempt_id,
                kind: request.kind,
                sequence: request.sequence,
                state: request.state,
                accounting: request.state === "settled"
                    ? DigestRender.#requestAccounting(request)
                    : null,
                started_at: request.started_at,
                completed_at: request.completed_at,
            })),
            log_entries: m.logEntries.map((le) => ({
                id: le.id, worker_id: le.worker_id, loop_id: le.loop_id,
                turn_id: le.turn_id, sequence: le.sequence, origin: le.origin,
                source: le.source, model_call_id: le.model_call_id,
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
                ...(le.status_rx >= 400 ? { problem: DigestRender.#rowProblem(le) } : {}),
            })),
            log_curation_effects: m.curationEffects.map(({ active_before, active_after, folded_before, folded_after, ...effect }) => ({
                ...effect,
                active_before: active_before === 1,
                active_after: active_after === 1,
                folded_before: DigestRender.parseJson(folded_before, []),
                folded_after: DigestRender.parseJson(folded_after, []),
            })),
        }, null, 2);
    }
}
