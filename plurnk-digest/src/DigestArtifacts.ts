import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { ChatMessage } from "@plurnk/plurnk-providers";
import { isRecord } from "@plurnk/plurnk-contracts";
import {
    accounting,
    environmentOf,
    link,
    literal,
    parseJson,
    renderStream,
    requestAccounting,
    rowProblem,
    terminalResult,
} from "./DigestFormat.ts";
import { cacheLedger, editCensus } from "./DigestLedgers.ts";
import type { DigestModel, ProviderRequestRow, TurnRow } from "./digest-rows.ts";

function* projectRows<T, R>(rows: Iterable<T>, project: (row: T) => R): Generator<R> {
    for (const row of rows) yield project(row);
}

const stemCache = new WeakMap<DigestModel, Map<number, string>>();

// {§share-packet-names}: the stem each turn's packet files carry is its log coordinate, session, loop and
// turn, as `log:///<loop>/<turn>/…` addresses it; a digest spanning workspaces nests one folder per
// workspace. Shared with the turn lines so a reader never counts files by hand.
export const packetStems = (m: DigestModel): Map<number, string> => {
    const cached = stemCache.get(m);
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
        const session = loop === undefined ? undefined : m.sessionsById.get(loop.session_id);
        if (loop === undefined || session === undefined) throw new TypeError(`turn ${turn.id} has no loop or session in scope`);
        const workspace = m.workspaces.find(({ id }) => id === session.workspace_id);
        const stem = `${nested ? `${segment(workspace?.name ?? String(session.workspace_id), session.workspace_id)}/` : ""}${segment(session.name, session.id)}-${loop.sequence}-${turn.sequence}`;
        if (taken.has(stem)) throw new TypeError(`two turns share the packet name ${stem}`);
        taken.add(stem);
        stems.set(turn.id, stem);
    }
    stemCache.set(m, stems);
    return stems;
};

export const turnLinks = (m: DigestModel, turn: TurnRow, from: string): string[] => {
    const stem = packetStems(m).get(turn.id);
    if (stem === undefined) return [];
    return [
        ...(turn.has_packet === 1 ? [link(from, `${stem}.request.md`, "Input")] : []),
        ...(turn.program !== null ? [link(from, `${stem}.assistant.md`, "Output")] : []),
        ...(turn.has_reasoning === 1 ? [link(from, `${stem}.reasoning.md`, "Reasoning")] : []),
    ];
};

// {§share-packet-names}: render the owned envelope, never infer roles from filenames or body text.
export const request = (messages: ReadonlyArray<ChatMessage & { content: string }>, preamble: readonly string[] = []): string => {
    const blocks = messages.map(({ role, content }, index) => {
        return `### ${index + 1}. ${role}\n\n${literal(content)}`;
    });
    return ["# Request", ...preamble, "## Input messages", messages.map(({ role }) => role).join(" → "),
        messages.length === 0 ? "No input message sections are retained; the original input cannot be reconstructed."
            : "Stored text-message envelope, not a transport capture. Native payloads and provider transformations are not shown.",
        ...blocks, ""].join("\n\n");
};

const admission = (m: DigestModel, req: ProviderRequestRow): string => {
    if (req.kind === "bare") return "not an emission";
    if (req.outcome !== "response") return "not admitted";
    const call = m.modelCalls.find(({ id }) => id === req.inference_call_id);
    return call?.accepted === 1 ? "admitted" : call?.accepted === 0 ? "rejected" : "not admitted";
};

// {§share-packet-names}: navigation surrounds evidence; channel files stay verbatim.
const requestPreamble = (m: DigestModel, turn: TurnRow): string[] => {
    const stems = packetStems(m);
    const stem = stems.get(turn.id)!;
    const from = `${stem}.request.md`;
    const loop = m.loopsById.get(turn.loop_id)!;
    const siblings = m.turns.filter((row) => row.has_packet === 1
        && m.loopsById.get(row.loop_id)?.session_id === loop.session_id).toSorted((a, b) => a.id - b.id);
    const index = siblings.findIndex(({ id }) => id === turn.id);
    const previous = siblings[index - 1];
    const next = siblings[index + 1];
    const navigation = [
        link(from, "digest.md", "Digest"),
        ...(previous === undefined ? [] : [link(from, `${stems.get(previous.id)!}.request.md`, "Previous")]),
        ...(next === undefined ? [] : [link(from, `${stems.get(next.id)!}.request.md`, "Next")]),
        ...turnLinks(m, turn, from).filter((item) => !item.startsWith("[Input]")),
    ];
    const lines = [posix.basename(stem), navigation.join(" · ")];
    const requests = m.requestsByTurn.get(turn.id) ?? [];
    if (requests.length > 0) {
        const table = ["| Request | Call | Admission | Outcome |", "| --- | --- | --- | --- |"];
        for (const req of requests) {
            table.push(`| ${link(from, `requests/${req.id}.md`, String(req.id))} | ${req.kind} ${req.inference_call_id} | ${admission(m, req)} | ${req.outcome ?? req.state} |`);
        }
        lines.push("## Attempts", table.join("\n"));
    }
    for (const attempt of m.attemptsByTurn.get(turn.id) ?? []) {
        if (attempt.accepted === 1) continue;
        const ordinal = String(attempt.sequence).padStart(3, "0");
        const prefix = `${stem}.attempt${ordinal}`;
        if (attempt.state !== "response") {
            lines.push(`### Emission attempt ${attempt.sequence}: ${attempt.state}`,
                link(from, `${prefix}.${attempt.state}.json`, "Call evidence"));
            if (attempt.failure !== null) lines.push(literal(attempt.failure, "json"));
            continue;
        }
        const admitted = attempt.accepted === 0 ? "rejected" : "unadmitted";
        lines.push(`### Emission attempt ${attempt.sequence}: ${admitted}`,
            m.evidence.response(attempt.model_call_id) === null ? "Response evidence is not retained."
                : link(from, `${prefix}.${admitted}.assistant.md`, "Exact output"),
            literal(JSON.stringify(parseJson(attempt.parse_errors, []), null, 2), "json"));
    }
    return lines;
};

const physicalRequest = (m: DigestModel, req: ProviderRequestRow, evidence: unknown): string => {
    const from = `requests/${req.id}.md`;
    const turn = m.turns.find(({ id }) => id === req.turn_id);
    const fields: Readonly<Record<string, unknown>> = isRecord(evidence) ? evidence : {};
    const capture = isRecord(fields.request) ? fields.request : undefined;
    const lines = [
        `# Physical request ${req.id}`,
        [link(from, "digest.md", "Digest"),
            link(from, `requests/${req.id}.json`, "Complete evidence")].join(" · "),
        ...(turn === undefined ? [] : [`Originating turn: ${turnLinks(m, turn, from).join(" · ") || "no packet artifacts retained"}`]),
        literal(JSON.stringify({
            provider: req.provider, model: req.model, kind: req.kind,
            inferenceCallId: req.inference_call_id, sequence: req.sequence,
            state: req.state, outcome: req.outcome, admission: admission(m, req),
            startedAt: req.started_at, completedAt: req.completed_at,
            ...(req.payloads_retired_at == null ? {} : { payloadsRetiredAt: req.payloads_retired_at }),
        }, null, 2), "json"),
        "## Accounting",
        req.state === "pending" ? "Request is unsettled; accounting is not yet available."
            : literal(JSON.stringify(requestAccounting(req), null, 2), "json"),
        "## Dispatched request",
        typeof capture?.body !== "string" ? "Dispatched request body was not retained."
            : `${String(capture.method)} ${String(capture.origin)}\n\nExact serialized body; URL details and request headers are not captured.\n\n${literal(capture.body, "json")}`,
    ];
    const call = m.modelCalls.find(({ id }) => id === req.inference_call_id);
    if (req.outcome === "response" && call?.accepted === 0) {
        lines.push("## Admission", "The provider returned a response, but Plurnk rejected its emission.",
            literal(JSON.stringify(parseJson(call.parse_errors, []), null, 2), "json"));
    }
    if (fields.error !== undefined) lines.push("## Failure", literal(JSON.stringify(fields.error, null, 2), "json"));
    if (evidence === null) lines.push("## Response", req.payloads_retired_at == null
        ? "No settled response evidence is retained."
        : `Payload retention applied at ${req.payloads_retired_at}; request identity and accounting remain.`);
    else {
        if (req.outcome === "error") lines.push("Partial output; this physical request failed. It is not an admitted response.");
        for (const [field, heading] of [["reasoning", "Reasoning"], ["content", "Content"]] as const) {
            lines.push(`## ${heading}`, typeof fields[field] === "string"
                ? literal(fields[field]) : `No readable ${field} is retained in this request record.`);
        }
    }
    return `${lines.join("\n\n")}\n`;
};

export const packetFiles = (m: DigestModel): string[] => {
    const written: string[] = [];
    const stems = packetStems(m);
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
        const preamble = turn.has_packet === 1 ? requestPreamble(m, turn) : [];
        if (packetFailure !== null) {
            files.push(
                [`${padded}.request.md`, ["# Request", ...preamble, "Stored packet is invalid; no input messages were reconstructed.",
                    literal(JSON.stringify(packetFailure.error, null, 2), "json"),
                    link(`${padded}.request.md`, `${padded}.packet.raw.txt`, "Stored packet")].join("\n\n")],
                [`${padded}.packet.raw.txt`, packetFailure.raw],
                [`${padded}.packet.invalid.json`, JSON.stringify({
                    turnId: turn.id,
                    error: packetFailure.error,
                }, null, 2)],
            );
        }
        if (packet !== null) {
            // {§packet-assembly} — the exact text messages the request carried; a stored packet
            // whose log cannot be projected is evidence of its own, never a reason to stop the digest.
            try {
                const messages = packet.messages();
                if (messages.length > 0) files.push(
                    [`${padded}.system.md`, packet.slot("system")],
                    [`${padded}.user.md`, packet.slot("user")],
                    [`${padded}.wire.json`, JSON.stringify(messages, null, 2)],
                );
                files.push(
                    [`${padded}.request.md`, request(messages, [
                        ...preamble,
                        ...(packet.attachments.length === 0 ? [] : ["## Native attachments", "Stored descriptors; selection alone does not prove transport or provider acceptance.", literal(JSON.stringify(packet.attachments, null, 2), "json")]),
                    ])],
                );
            } catch (cause) {
                files.push([`${padded}.wire.invalid.json`, JSON.stringify({ turnId: turn.id, error: cause instanceof Error ? cause.message : String(cause) }, null, 2)]);
                files.push([`${padded}.request.md`, ["# Request", ...preamble,
                    "Stored input could not be projected; no message order was reconstructed.",
                    link(`${padded}.request.md`, `${padded}.wire.invalid.json`, "Projection failure")].join("\n\n")]);
            }
        }
        if (source !== null) {
            files.push([`${padded}.assistant.md`, source]);
        }
        const reasoning = m.evidence.reasoning(turn);
        if (reasoning !== null) files.push([`${padded}.reasoning.md`, reasoning]);
        if (packet?.assistant != null) {
            if (source !== null && packet.assistant.content !== source) {
                throw new TypeError(`turn ${turn.id} packet assistant differs from its turnOps source`);
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
                    failure: parseJson(attempt.failure),
                    attributions: parseJson(attempt.attributions, []),
                    openedAt: attempt.timestamp,
                    completedAt: attempt.completed_at,
                }, null, 2));
                continue;
            }
            const retainedResponse = m.evidence.response(attempt.model_call_id);
            const admitted = attempt.accepted === 0 ? "rejected" : "unadmitted";
            const prefix = `${padded}.attempt${attemptPadded}.${admitted}`;
            write(`${prefix}.parse-errors.json`, JSON.stringify(parseJson(attempt.parse_errors, []), null, 2));
            write(`${prefix}.attributions.json`, JSON.stringify(parseJson(attempt.attributions, []), null, 2));
            if (retainedResponse === null) {
                write(`${prefix}.response.md`, `# Emission attempt ${attempt.sequence}: ${admitted}\n\nResponse evidence is not retained.\n`);
                continue;
            }
            const response = parseJson(retainedResponse, {});
            const assistant = isRecord(response) && isRecord(response.assistant) ? response.assistant : null;
            const attemptFiles: Array<[string, string]> = [
                [
                    `${prefix}.assistant.md`,
                    typeof assistant?.content === "string" ? assistant.content : "",
                ],
                [`${prefix}.response.json`, JSON.stringify(response, null, 2)],
            ];
            for (const [file, body] of attemptFiles) write(file, body);
        }
    });
    for (const req of m.providerRequests) {
        const evidence = parseJson(m.evidence.request(req.id));
        write(`requests/${req.id}.md`, physicalRequest(m, req, evidence));
        write(`requests/${req.id}.json`, JSON.stringify({
            id: req.id,
            inferenceCallId: req.inference_call_id,
            sequence: req.sequence,
            provider: req.provider,
            model: req.model,
            state: req.state,
            startedAt: req.started_at,
            completedAt: req.completed_at,
            accounting: req.state === "settled" ? requestAccounting(req) : null,
            evidence,
        }, null, 2));
    }
    return written;
};

export function* json(m: DigestModel): Generator<string> {
    const census = editCensus(m);
    const stems = packetStems(m);
    const ledger = cacheLedger(m);
    const fields = {
        dbPath: m.dbPath,
        storage: m.storage,
        search: m.search,
        workspaces: m.workspaces.map((s) => ({
            id: s.id,
            name: s.name,
            accounting: accounting(m.requestsByWorkspace.get(s.id) ?? []),
        })),
        sessions: m.sessions.map((r) => ({
            id: r.id,
            workspace_id: r.workspace_id,
            name: r.name,
            owner: r.owner,
            accounting: accounting(m.requestsBySession.get(r.id) ?? []),
            edit_census: census.bySession.get(r.id) ?? null,
        })),
        loops: m.loops.map((l) => ({
            id: l.id, session_id: l.session_id, sequence: l.sequence, status: l.status,
            prompt: l.prompt,
            terminated_by: l.terminated_by,
            claimed_at: l.claimed_at,
            terminated_at: l.terminated_at,
            result: terminalResult(l),
            accounting: accounting(m.requestsByLoop.get(l.id) ?? []),
        })),
        turns: projectRows(m.turns, (t) => {
            const { packet, packetFailure } = m.evidence.packet(t);
            return {
                id: t.id, loop_id: t.loop_id, sequence: t.sequence,
                // {§share-packet-names}: the stem of this turn's packet files, or null when it wrote none.
                artifact: stems.get(t.id) ?? null,
                producer: t.producer, kind: t.kind,
                program: t.program,
                status: t.status, completed_at: t.completed_at,
                accounting: accounting(m.requestsByTurn.get(t.id) ?? []),
                finish_reason: t.finish_reason, model: t.model,
                attributions: packet?.attributions ?? [],
                attachments: packet === null ? null : packet.attachments ?? [],
                packet_failure: packetFailure,
                // Preserve the opaque provider and engine metadata for aggregate
                // tooling. {§provider-surface}, {§provider-instantiation}
                meta: parseJson(t.meta ?? "null", null),
            };
        }),
        inference_calls: m.inferenceCalls.map((call) => ({
            id: call.id,
            workspace_id: call.workspace_id,
            turn_id: call.turn_id,
            sequence: call.sequence,
            kind: call.kind,
            state: call.state,
            attributions: parseJson(call.attributions, []),
            request_model: call.request_model,
            accounting: accounting(m.requestsByInferenceCall.get(call.id) ?? []),
            timestamp: call.timestamp,
            completed_at: call.completed_at,
        })),
        model_calls: projectRows(m.modelCalls, (call) => ({
            id: call.id,
            turn_id: call.turn_id,
            sequence: call.sequence,
            kind: call.kind,
            state: call.state,
            response: parseJson(m.evidence.response(call.id)),
            failure: parseJson(call.failure),
            attributions: parseJson(call.attributions, []),
            accounting: accounting(m.requestsByInferenceCall.get(call.id) ?? []),
            finish_reason: call.finish_reason,
            model: call.model,
            request_model: call.request_model,
            response_model: call.response_model,
            timestamp: call.timestamp,
            completed_at: call.completed_at,
            turn_attempt_id: call.turn_attempt_id,
            accepted: call.accepted === null ? null : call.accepted === 1,
            parse_errors: parseJson(call.parse_errors, []),
            log_entry_id: call.log_entry_id,
        })),
        turn_attempts: projectRows(m.turnAttempts, (attempt) => ({
            id: attempt.id,
            turn_id: attempt.turn_id,
            sequence: attempt.sequence,
            state: attempt.state,
            accepted: attempt.accepted === null ? null : attempt.accepted === 1,
            response: parseJson(m.evidence.response(attempt.model_call_id)),
            failure: parseJson(attempt.failure),
            parse_errors: parseJson(attempt.parse_errors, []),
            attributions: parseJson(attempt.attributions, []),
            accounting: accounting(m.requestsByAttempt.get(attempt.id) ?? []),
            finish_reason: attempt.finish_reason,
            model: attempt.model,
            timestamp: attempt.timestamp,
            completed_at: attempt.completed_at,
        })),
        provider_requests: m.providerRequests.map((req) => ({
            id: req.id,
            evidence: `requests/${req.id}.json`,
            inference_call_id: req.inference_call_id,
            turn_attempt_id: req.turn_attempt_id,
            kind: req.kind,
            sequence: req.sequence,
            state: req.state,
            accounting: req.state === "settled"
                ? requestAccounting(req)
                : null,
            ...ledger.get(req.id)!,
            started_at: req.started_at,
            completed_at: req.completed_at,
            ...(req.payloads_retired_at == null ? {} : { payloadsRetiredAt: req.payloads_retired_at }),
        })),
        log_entries: m.logEntries.map((le) => {
            const stream = renderStream(le);
            const env = environmentOf(le, m);
            return {
                id: le.id, session_id: le.session_id, loop_id: le.loop_id,
                turn_id: le.turn_id, sequence: le.sequence, origin: le.origin,
                source: le.source, model_call_id: le.model_call_id,
                ...(le.inherited_history === undefined ? {} : { inherited_history: le.inherited_history === 1 }),
                ...(le.ambient_event_id === undefined ? {} : { ambient_event_id: le.ambient_event_id }),
                attrs: parseJson(le.attrs, {}),
                op: le.op, target: le.target,
                status_rx: le.status_rx, state: le.state, outcome: le.outcome,
                ...(le.proposalDecision === undefined ? {} : { proposalDecision: le.proposalDecision }),
                initial_folded: parseJson(le.initial_folded, []),
                projection: {
                    active: le.projection_active === 1,
                    folded: parseJson(le.projection_folded, []),
                },
                ...(stream === null ? {} : { stream }),
                ...(env === undefined ? {} : { env }),
                ...(le.status_rx >= 400 ? { problem: rowProblem(le) } : {}),
                ...(census.formById.has(le.id)
                    ? { edit_form: census.formById.get(le.id), edit_revisit: census.revisitById.has(le.id) }
                    : {}),
            };
        }),
        log_curation_effects: m.curationEffects.map(({ active_before, active_after, folded_before, folded_after, ...effect }) => ({
            ...effect,
            active_before: active_before === 1,
            active_after: active_after === 1,
            folded_before: parseJson(folded_before, []),
            folded_after: parseJson(folded_after, []),
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
