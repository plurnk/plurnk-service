// Digest renderers ({§share-packet-names}): the markdown, JSON, reasoning, and packet
// artifacts of one DigestModel, reading heavy evidence on demand through DigestEvidence.
import { isRecord } from "@plurnk/plurnk-contracts";
import {
    accounting,
    costSummary,
    environmentOf,
    envLine,
    indentLines,
    link,
    literal,
    parseJson,
    renderStream,
    rowProblem,
    terminalResult,
    usageSummary,
    wireLine,
} from "./DigestFormat.ts";
import {
    cacheBadge,
    cacheLedger,
    cacheLine,
    countsAsError,
    editCensus,
    editForm,
    loopHealth,
    renderEditCensus,
    renderEmissions,
    renderReasonings,
    renderRoom,
} from "./DigestLedgers.ts";
import { json, packetFiles, packetStems, request, turnLinks } from "./DigestArtifacts.ts";
import type { DigestModel, LogRow, LoopRow, SessionRow, TurnRow } from "./digest-rows.ts";

export default class DigestRender {
    static parseJson = parseJson;
    static usageSummary = usageSummary;
    static costSummary = costSummary;
    static envLine = envLine;
    static wireLine = wireLine;
    static editForm = editForm;
    static cacheLedger = cacheLedger;
    static packetStems = packetStems;
    static request = request;
    static packetFiles = packetFiles;
    static json = json;

    static #renderOpLine(le: LogRow, label: string = le.op ?? "source artifact", environment?: unknown): string {
        const target = le.target ?? "—";
        const stream = renderStream(le);
        const state = le.state !== "resolved" ? ` state=${le.state}` : "";
        const outcome = le.outcome !== null ? ` outcome=${le.outcome}` : "";
        const streamLink = stream === null ? "" : ` stream=${stream}`;
        const source = le.source === null ? "" : ` source=${le.source}`;
        const fail = le.status_rx >= 400 ? " ✗" : "";
        // For failed outcomes, surface the Problem Details explanation from rx so
        // the waterfall explains WHY each failure happened without opening packets.
        let errLine = "";
        if (le.status_rx >= 400) {
            errLine = `\n    -> ${rowProblem(le).detail.trim()}`;
        }
        const env = envLine(environment);
        const envText = env === null ? "" : `\n    ${env}`;
        const decision = le.proposalDecision;
        const approval = decision === undefined ? "" : `\n    decision=${decision.decision} resolver=${decision.resolver} at=${decision.decided_at}${decision.body === null ? "" : " body override recorded"}${decision.outcome === null ? "" : ` outcome=${decision.outcome}`}`;
        return `  ← [${le.origin}] ${label}[${le.status_rx}] ${target}${source}${state}${outcome}${streamLink}${fail}${errLine}${envText}${approval}`;
    }

    static #renderGroupedOpLine(row: LogRow, m: DigestModel): string {
        const parsedAttrs = parseJson(row.attrs, {});
        const attrs: Readonly<Record<string, unknown>> = isRecord(parsedAttrs) ? parsedAttrs : {};
        // {§turn-source-resources}: the announcement of an admitted emission, and whether the model retired it.
        if (row.op === "READ" && attrs.kind === "emission") {
            return DigestRender.#renderOpLine(row, row.projection_active === 1 ? "emission" : "emission (killed)", environmentOf(row, m));
        }
        // {§turn-source-resources}: the turn's reasoning landed as a row, and whether the model retired it.
        if (row.op === "READ" && attrs.kind === "reasoning") {
            return DigestRender.#renderOpLine(row, row.projection_active === 1 ? "reasoning" : "reasoning (killed)", environmentOf(row, m));
        }
        const materialized = row.origin === "_plurnk" && row.op === "EDIT" && attrs.kind === "entry_materialized";
        const actionlessKind = row.op === null ? attrs.kind : null;
        const label = actionlessKind === "emissionAttempt"
            ? "emission attempt"
            : row.op ?? `unrecognized actionless row (kind=${JSON.stringify(actionlessKind) ?? "absent"})`;
        return DigestRender.#renderOpLine(row, materialized ? "materialized entry" : label, environmentOf(row, m));
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

    // {§share-packet-names} — size, free pages, vacuum mode and the largest tables, one line.
    static #storageLine(storage: DigestModel["storage"]): string {
        const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;
        const mode = ["off", "full", "incremental"][storage.auto_vacuum] ?? String(storage.auto_vacuum);
        return `Storage: ${mb(storage.bytes)} (free ${mb(storage.free_bytes)}, auto_vacuum ${mode}) · largest: ${storage.tables.map(({ name, bytes }) => `${name} ${mb(bytes)}`).join(", ")}`;
    }

    // {§session-wait-timing} — claim to first model turn: a stall between them is a number, not a gap.
    static #wakeLatency(loop: LoopRow, m: DigestModel): string | null {
        if (loop.claimed_at === null) return null;
        const first = (m.turnsByLoop.get(loop.id) ?? []).filter((t) => t.kind === "inference").toSorted((a, b) => a.sequence - b.sequence)[0];
        if (first === undefined) return `Claimed: ${loop.claimed_at} · no model turn`;
        const seconds = (Date.parse(first.timestamp) - Date.parse(loop.claimed_at)) / 1000;
        return `Claimed: ${loop.claimed_at} · first model turn +${seconds.toFixed(1)} s`;
    }

    // Among its loop's model turns, this one's ordinal: the model's own count, which skips the
    // harness turns a reader would otherwise have to subtract.
    static #modelTurnOrdinal(turn: TurnRow, m: DigestModel): number | null {
        if (turn.producer !== "model") return null;
        const siblings = (m.turnsByLoop.get(turn.loop_id) ?? []).filter((t) => t.producer === "model");
        const index = siblings.findIndex((t) => t.id === turn.id);
        return index < 0 ? null : index + 1;
    }

    static #renderTurnLine(turn: TurnRow, m: DigestModel): string {
        const { packet, packetFailure } = m.evidence.packet(turn);
        const assistant = packet?.assistant ?? null;
        const content = assistant?.content ?? "";
        const reasoning = assistant?.reasoning ?? null;
        const acct = accounting(m.requestsByTurn.get(turn.id) ?? []);
        const tokens = usageSummary(acct);
        const cost = ` cost=${costSummary(acct)}`;
        const finishReason = turn.finish_reason ?? "—";
        // Render only observed transport metadata; absence makes no claim
        // about endpoint-owned settings. {§provider-instantiation}
        const tm = parseJson(turn.meta ?? "null", null);
        const railsFlag = isRecord(tm) ? tm.railsAttached : undefined;
        const attached = typeof railsFlag === "boolean" || typeof railsFlag === "string" ? railsFlag : undefined;
        const rails = attached === undefined || attached === false ? ""
            : ` rails=${attached === true ? "client" : attached}`;
        const model = turn.model ?? "—";
        // {§outside-text}: the weight the model was told, so a digest reader sees the discard at a glance.
        const outside = turn.outside === null ? "" : ` outside=${m.evidence.textWeight(turn.outside)} tok`;
        const errs = (m.logEntriesByTurn.get(turn.id) ?? [])
            .filter((le) => countsAsError(le)).length;
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
        const stem = packetStems(m).get(turn.id);
        const modelTurn = DigestRender.#modelTurnOrdinal(turn, m);
        const provenance = [modelTurn === null ? null : `model turn ${modelTurn}`, stem].filter((part) => part !== null).join(" · ");
        const lifecycle = `T${turn.sequence}${provenance === "" ? "" : ` (${provenance})`}: producer=${turn.producer} kind=${turn.kind} status=${turn.status}${turn.completed_at === null ? " state=open" : ""}`;
        const head = turn.kind === "inference"
            ? `${lifecycle} finish=${finishReason}${rails} model=${model} ${tokens}${cost}${cacheBadge(turn, m)}${outside}${errBadge}${attemptBadge}${packetBadge}`
            : `${lifecycle}${errBadge}${packetBadge}`;
        let summary: string | null = null;
        if (packetFailure !== null) {
            summary = `  ↳ provider packet: invalid stored evidence (${packetFailure.error.message})`;
        } else if (packet === null) {
            summary = null;
        } else if (content.length > 0) {
            summary = content.includes("\n")
                ? `  ↳ emission:\n${indentLines(content.trimEnd(), "    ")}`
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
                ? `  ↳ reasoning:\n${indentLines(reasoning.trimEnd(), "    ")}`
                : `  ↳ reasoning: ${reasoning.trim()}`)
            : null;
        // {§provider-failure-normalization} — an empty emission is read from what the wire carried, never guessed at.
        const wire = content.length === 0 && packet?.assistant != null ? wireLine(packet.assistantRaw) : null;
        const roles = packet?.messages().map(({ role }) => role).join(" → ");
        const requestLine = packet === null ? null
            : `  ↳ request: ${roles || "input sections not retained"} (${stem}.request.md)`;
        const opLines = DigestRender.#renderOpLines(m.logEntriesByTurn.get(turn.id) ?? [], m);
        return [head, ...(requestLine ? [requestLine] : []), ...(summary ? [summary] : []), ...(reasoningLine ? [reasoningLine] : []), ...(wire ? [wire] : []), ...opLines].join("\n");
    }

    static #renderSessionShape(session: SessionRow, m: DigestModel): string {
        // every session has exactly one rollup row — digest_session_rollups is FROM sessions
        const roll = m.sessionRollups.get(session.id)!;
        const opMix = (m.opMixBySession.get(session.id) ?? []).map((o) => `${o.op}=${o.n}`).join(" ");
        const requests = m.requestsBySession.get(session.id) ?? [];
        const acct = accounting(requests);
        const usageStr = requests.length === 0
            ? "no provider requests"
            : usageSummary(acct);
        const costStr = requests.length === 0
            ? "n/a"
            : costSummary(acct);
        // {§digest-forensic-fidelity} (#461): settled exchanges that carry no usage at
        // all (errored/aborted) billed server-side invisibly; say so, never price-as-zero.
        const usageless = requests.filter((row) => row.state === "settled" && row.usage_total === null).length;
        const usagelessStr = usageless > 0
            ? ` (+${usageless} usage-less request${usageless === 1 ? "" : "s"} — server-side spend unrecorded)`
            : "";
        // {§digest-forensic-fidelity} (#473): a dollar figure without its basis reads as billed
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
        // {§digest-forensic-fidelity} (#473): provider-level errors are absorbed by retries below
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
            `Room:       ${renderRoom(session, m)}`,
            `Op mix:     ${opMix.length > 0 ? opMix : "(no ops)"}`,
            `EDITs:      ${renderEditCensus(editCensus(m).bySession.get(session.id))}`,
            `Emissions:  ${renderEmissions(session, m)}`,
            `Reasonings: ${renderReasonings(session, m)}`,
        ].join("\n");
    }

    static waterfall(m: DigestModel): string {
        const lines: string[] = [];
        lines.push("# plurnk-service digest");
        lines.push("");
        lines.push(`DB: ${m.dbPath}`);
        lines.push(DigestRender.#storageLine(m.storage));
        const rejectedAttempts = m.turnAttempts.filter((attempt) => attempt.accepted === 0).length;
        const erroredCalls = m.inferenceCalls.filter((call) => call.state === "error").length;
        const pendingCalls = m.inferenceCalls.filter((call) => call.state === "pending").length;
        const bareCalls = m.modelCalls.filter((call) => call.kind === "bare").length;
        const pendingRequests = m.providerRequests.filter((req) => req.state === "pending").length;
        const packetFailures = m.turns.filter((turn) => m.evidence.packet(turn).packetFailure !== null).length;
        lines.push(`Workspaces: ${m.workspaces.length}  Sessions: ${m.sessions.length}  Loops: ${m.loops.length}  Turns: ${m.turns.length}  Inference calls: ${m.inferenceCalls.length} (${bareCalls} BARE, ${erroredCalls} errored, ${pendingCalls} open)  Emission attempts: ${m.turnAttempts.length} (${rejectedAttempts} rejected)  Provider requests: ${m.providerRequests.length} (${pendingRequests} open)  Log entries: ${m.logEntries.length}`);
        if (packetFailures > 0) lines.push(`Stored packet failures: ${packetFailures}`);
        lines.push(`Search: channels=${m.search.channel_entries} attached=${m.search.derivation_complete} (indexed=${m.search.indexed} excluded=${m.search.excluded} unsearchable=${m.search.unsearchable} failed=${m.search.failed}) unattached=${m.search.unfinished} artifacts=${m.search.derivation_artifacts_complete} complete/${m.search.derivation_artifacts_building} building`);
        const health = m.loops.map((l) => loopHealth(l, m));
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
            lines.push(cacheLine(m.requestsByWorkspace.get(workspace.id) ?? [], m));
            const workspaceSessions = m.sessionsByWorkspace.get(workspace.id) ?? [];
            for (const session of workspaceSessions) {
                lines.push("");
                lines.push(`### Session #${session.id} — ${session.name}`);
                lines.push(`Owner: ${session.owner}`);
                lines.push("");
                lines.push("```");
                lines.push(DigestRender.#renderSessionShape(session, m));
                lines.push("```");
                const sessionLoops = m.loopsBySession.get(session.id) ?? [];
                for (const loop of sessionLoops) {
                    const terminal = terminalResult(loop);
                    lines.push("");
                    const h = loopHealth(loop, m);
                    const badge = h.verdict === "CLEAN"
                        ? " — CLEAN"
                        : ` — ${h.verdict === "DEGENERATE-WIN" ? "⚠ DEGENERATE-WIN" : h.verdict} (${h.errors} errors, ${h.errorItems} error-items)`;
                    lines.push(`#### Loop ${loop.sequence} (id=${loop.id}, status=${loop.status})${badge}`);
                    lines.push("");
                    if (loop.prompt.includes("\n")) {
                        lines.push("Prompt:\n" + indentLines(loop.prompt.trimEnd(), "  "));
                    } else {
                        lines.push(`Prompt: ${loop.prompt}`);
                    }
                    const wake = DigestRender.#wakeLatency(loop, m);
                    if (wake !== null) lines.push(wake);
                    if (loop.status !== 200 && terminal?.problem?.detail !== undefined) {
                        lines.push(`Terminal${loop.terminated_by !== null ? ` (${loop.terminated_by})` : ""}: ${terminal.problem.detail.trim()}`);
                    }
                    lines.push("");
                    lines.push("| Turn | Packet artifacts | Physical requests |", "| --- | --- | --- |");
                    for (const turn of m.turnsByLoop.get(loop.id) ?? []) {
                        const requests = (m.requestsByTurn.get(turn.id) ?? []).map((req) =>
                            link("digest.md", `requests/${req.id}.md`, `${req.id}: ${req.kind} ${req.outcome ?? req.state}`));
                        lines.push(`| ${turn.sequence} (${turn.kind}) | ${turnLinks(m, turn, "digest.md").join(" · ") || "—"} | ${requests.join(" · ") || "—"} |`);
                    }
                    lines.push("");
                    const turnLines = (m.turnsByLoop.get(loop.id) ?? []).map((t) => DigestRender.#renderTurnLine(t, m));
                    lines.push(literal(turnLines.join("\n"), ""));
                }
            }
        }
        return lines.join("\n");
    }

    static reasoning(m: DigestModel): string {
        const lines: string[] = [];
        lines.push("# plurnk-service reasoning");
        lines.push("");
        lines.push("Turn chronology with every provider attempt. Rejected attempts remain explicit forensic evidence.");
        for (const t of m.turns) {
            const loop = m.loopsById.get(t.loop_id);
            const session = loop ? m.sessionsById.get(loop.session_id) : undefined;
            lines.push("");
            lines.push(`## Session ${session?.id ?? "?"} / Loop ${loop?.sequence ?? "?"} / Turn ${t.sequence} (id=${t.id}, producer=${t.producer}, kind=${t.kind})`);
            if (t.kind !== "inference") {
                lines.push("");
                lines.push("(operation turn; no provider inference)");
                const reasoning = m.evidence.reasoning(t);
                if (reasoning !== null) lines.push("", literal(reasoning));
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
                else if (typeof reasoning === "string" && reasoning.length > 0) lines.push(literal(reasoning));
                else lines.push("(no admitted provider reasoning)");
                continue;
            }
            for (const attempt of attempts) {
                const retainedResponse = m.evidence.response(attempt.model_call_id);
                const response = parseJson(retainedResponse, {});
                const assistant = isRecord(response) && isRecord(response.assistant) ? response.assistant : null;
                const parsedErrors = parseJson(attempt.parse_errors, []);
                const parseErrors: readonly unknown[] = Array.isArray(parsedErrors) ? parsedErrors : [];
                lines.push("");
                const disposition = attempt.state === "error"
                    ? "call error"
                    : attempt.state === "pending"
                        ? "open at capture"
                        : attempt.accepted === 1
                            ? "admitted"
                            : "rejected";
                lines.push(`### Attempt ${attempt.sequence} - ${disposition}`);
                const parsedAttributions = parseJson(attempt.attributions, []);
                const attributions: readonly unknown[] = Array.isArray(parsedAttributions) ? parsedAttributions : [];
                lines.push(`Attributions: ${attributions.length === 0 ? "(none)" : attributions.join(", ")}`);
                if (attempt.failure !== null) {
                    lines.push(`Failure: ${JSON.stringify(parseJson(attempt.failure, attempt.failure))}`);
                }
                for (const req of m.requestsByAttempt.get(attempt.id) ?? []) {
                    lines.push(`Physical request ${req.sequence}: [${req.state === "settled" ? req.outcome : req.state} evidence](requests/${req.id}.md)`);
                }
                if (attempt.accepted !== 1) {
                    for (const error of parseErrors) {
                        const message = isRecord(error) ? error.message : undefined;
                        if (typeof message === "string") lines.push(`- ${message}`);
                    }
                    lines.push("");
                }
                const reasoning = assistant?.reasoning ?? null;
                if (typeof reasoning === "string" && reasoning.length > 0) lines.push(literal(reasoning));
                else if (retainedResponse === null && attempt.state === "response") lines.push("(response evidence is not retained; readable reasoning availability is unknown)");
                else {
                    const reasoningTokens = accounting(
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
}
