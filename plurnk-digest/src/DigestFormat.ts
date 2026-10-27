import { posix } from "node:path";
import {
    aggregateProviderAccounting,
    type ProviderAccounting,
    type ProviderRequestAccounting,
} from "@plurnk/plurnk-providers";
import { Validator, isRecord, isExecutionOp, type OperationResult, type ProblemDetails } from "@plurnk/plurnk-contracts";
import type { DigestModel, LogRow, LoopRow, ProviderRequestRow } from "./digest-rows.ts";

export const literal = (body: string, language = "text"): string => {
    let length = 3;
    for (const match of body.matchAll(/`+/gu)) length = Math.max(length, match[0].length + 1);
    const fence = "`".repeat(length);
    return `${fence}${language}\n${body}\n${fence}`;
};

export const link = (from: string, target: string, label: string): string =>
    `[${label}](${posix.relative(posix.dirname(from), target)})`;

export const summarize = (text: unknown, n = 80): string => {
    if (text === null || text === undefined) return "";
    const flat = (typeof text === "string" ? text : JSON.stringify(text) ?? "").replace(/\s+/g, " ").trim();
    if (flat.length <= n) return flat;
    return `${flat.slice(0, n)}…`;
};

export const indentLines = (text: string, prefix = "    "): string =>
    text.split("\n").map((line) => line.length > 0 ? `${prefix}${line}` : line).join("\n");

export const parseJson = (s: unknown, fallback: unknown = null): unknown => {
    if (s === null || s === undefined) return fallback;
    const text = typeof s === "string" ? s : Buffer.isBuffer(s) ? s.toString("utf8") : null;
    if (text === null) return fallback;
    try { return JSON.parse(text); } catch { return fallback; }
};

export const requestAccounting = (row: ProviderRequestRow): ProviderRequestAccounting => {
    if (row.state !== "settled" || row.accounting === null) {
        throw new TypeError(`provider request ${row.id} is not settled`);
    }
    return row.accounting;
};

export const accounting = (rows: readonly ProviderRequestRow[]): ProviderAccounting | null =>
    rows.some((row) => row.state !== "settled")
        ? null
        : aggregateProviderAccounting(rows.map((row) => requestAccounting(row)));

export const usageSummary = (acct: ProviderAccounting | null): string => {
    if (acct === null) return "accounting=incomplete";
    const usage = acct.usage;
    const known = acct.knownUsage;
    const quantity = (total: number | undefined, subtotal: number | undefined): string =>
        total !== undefined ? String(total) : subtotal === undefined ? "unknown" : `${subtotal}+?`;
    return [
        `input=${quantity(usage?.inputTokens, known?.inputTokens)}`,
        `output=${quantity(usage?.outputTokens, known?.outputTokens)}`,
        `reasoning=${quantity(usage?.outputTokenDetails?.reasoningTokens, known?.outputTokenDetails?.reasoningTokens)}`,
        `cache-read=${quantity(usage?.inputTokenDetails?.cacheReadTokens, known?.inputTokenDetails?.cacheReadTokens)}`,
    ].join(" ");
};

export const costSummary = (acct: ProviderAccounting | null): string => {
    if (acct?.costUsd != null) return `$${acct.costUsd}`;
    return acct?.knownCostUsd == null ? "unknown" : `$${acct.knownCostUsd} + ? (incomplete)`;
};

export const operationResult = (raw: unknown, subject: string): OperationResult => {
    try {
        return Validator.assertOperationResult(parseJson(raw));
    } catch (cause) {
        throw new Error(`${subject} does not contain a valid operation result`, { cause });
    }
};

export const rowProblem = (row: LogRow): ProblemDetails => {
    const result = operationResult(row.rx, `failed log entry ${row.id}`);
    if (result.problem === undefined) {
        throw new Error(`failed log entry ${row.id} does not contain Problem Details`);
    }
    return result.problem;
};

export const terminalResult = (loop: LoopRow): OperationResult | null =>
    loop.terminal_result === null
        ? null
        : operationResult(loop.terminal_result, `terminal loop ${loop.id}`);

export const renderStream = (le: LogRow): string | null => {
    if (!isExecutionOp(le.op)) return null;
    const attrs = parseJson(le.attrs, {});
    const stream = isRecord(attrs) ? attrs.stream : undefined;
    return typeof stream === "string" ? stream : null;
};

// {§execution-output-identity} — the environment a spawn received, as recorded on its row: host names by
// name, the Session's own values, inherited values by their source, masked names. Host values
// stay in digest.json. Part of the rendered line, so spawns under different environments never
// collapse into one group.
export const envLine = (env: unknown): string | null => {
    if (!isRecord(env)) return null;
    const host: string[] = [];
    const rest: string[] = [];
    for (const [name, raw] of Object.entries(env).toSorted(([left], [right]) => left.localeCompare(right))) {
        const record: Readonly<Record<string, unknown>> = isRecord(raw) ? raw : {};
        const from = typeof record.from === "string" ? record.from : null;
        if (record.source === "host") host.push(name);
        else if (record.source === "masked") rest.push(`${name} (masked${from === null ? "" : ` by ${from}`})`);
        else if (record.source === "workspace") rest.push(`${name}=${summarize(record.value, 60)} (workspace)`);
        else rest.push(`${name}=${summarize(record.value, 60)} (${from === null ? "session" : `from ${from}`})`);
    }
    const parts = [...(host.length === 0 ? [] : [`host ${host.join(",")}`]), ...rest];
    return `env: ${parts.length === 0 ? "(empty)" : parts.join(" · ")}`;
};

// The environment a spawn recorded on its output, found through the row's stream address.
export const environmentOf = (le: LogRow, m: DigestModel): unknown => {
    const stream = renderStream(le);
    if (stream === null) return undefined;
    const session = m.sessionsById.get(le.session_id);
    return session === undefined ? undefined : m.environments.get(`${session.workspace_id}:${stream}`);
};

// {§provider-failure-normalization} — an empty emission is read from what the wire carried, never guessed at.
export const wireLine = (assistantRaw: unknown): string | null => {
    const wire = isRecord(assistantRaw) && isRecord(assistantRaw.wire) ? assistantRaw.wire : null;
    if (wire === null) return null;
    const chunks = typeof wire.chunks === "number" ? wire.chunks : 0;
    const emptyChunks = typeof wire.emptyChunks === "number" ? wire.emptyChunks : 0;
    const fields = isRecord(wire.fields) ? wire.fields : {};
    const channels = isRecord(wire.channels) ? wire.channels : {};
    const toolCalls: readonly unknown[] = Array.isArray(wire.toolCalls) ? wire.toolCalls : [];
    const unmappedChunks: readonly unknown[] = Array.isArray(wire.unmappedChunks) ? wire.unmappedChunks : [];
    const parts = [
        `${chunks} chunks`,
        emptyChunks > 0 ? `${emptyChunks} carried nothing` : null,
        ...Object.entries(fields).map(([field, count]) => `${field}×${String(count)}`),
        ...toolCalls.map((call) => {
            const name = isRecord(call) && typeof call.name === "string" ? call.name : "?";
            return `tool call ${name}(${summarize(isRecord(call) ? call.arguments : undefined, 60)})`;
        }),
        ...Object.entries(channels).map(([channel, text]) => `${channel}: ${summarize(text, 60)}`),
        unmappedChunks.length > 0 ? `${unmappedChunks.length} unmapped frames retained` : null,
    ].filter((part) => part !== null);
    return `  ↳ wire: ${parts.join(", ")}`;
};
