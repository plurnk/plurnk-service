// The envelope experiment (#893, the wire shape): a recorded rollout's packets re-sent with identical
// bytes in two envelopes — today's (system + one user message holding the whole packet) and the
// turn envelope (system, one assistant message per turn's log rows, then the status clump as the
// user message). Measured per sample: reasoning tokens, whether the reasoning restarts from the
// task, and whether the first operation matches what the model actually did at that turn.
// A paid experiment, never a test.
// usage: node --conditions=plurnk-dev test/replay/envelope-replay.mjs <alias> <run-digest-dir> <worker> <turns e.g. 4,8,12> <samples> <concurrency> <out.jsonl> [arms=today,turns,ops,turnsline,lastturn,lastturn-causal,syslog]
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadActiveProvider } from "@plurnk/plurnk-providers";

const [alias, digestDir, worker, turnsArg, samplesArg, concurrencyArg, out, armsArg = "today,turns,ops"] = process.argv.slice(2);
if (!alias || !digestDir || !worker || !turnsArg || !out) throw new Error("usage: envelope-replay.mjs <alias> <digest-dir> <worker> <turns> <samples> <concurrency> <out.jsonl> [arms]");
const samples = Number(samplesArg ?? 3);
const concurrency = Number(concurrencyArg ?? 3);
process.loadEnvFile(`${process.env.HOME}/.config/plurnk/.env`);
const provider = await loadActiveProvider({ ...process.env, PLURNK_MODEL: alias });

const packet = (turn) => {
    const base = join(digestDir, `${worker}-1-${turn}`);
    if (!existsSync(`${base}.user.md`)) throw new Error(`no recorded packet for turn ${turn}`);
    return { system: readFileSync(`${base}.system.md`, "utf8"), user: readFileSync(`${base}.user.md`, "utf8"), recorded: readFileSync(`${base}.assistant.md`, "utf8") };
};

// The turn envelope: the Log section split by the turn each row belongs to.
const turnEnvelope = (user) => {
    const clumpAt = user.indexOf("\n## Worker\n");
    if (clumpAt < 0) throw new Error("recorded packet has no Worker section");
    const log = user.slice(0, clumpAt);
    const clump = user.slice(clumpAt + 1);
    const lines = log.split("\n");
    const messages = [];
    let currentTurn = null;
    let buffer = [];
    const flush = () => { if (buffer.length > 0) { messages.push({ role: "assistant", content: buffer.join("\n").trimEnd() }); buffer = []; } };
    for (const line of lines) {
        const header = /^### log:\/\/\/(\d+)\/(\d+)\/(\d+)\//u.exec(line);
        if (header !== null) {
            const turn = Number(header[2]);
            if (currentTurn !== null && turn !== currentTurn) flush();
            currentTurn = turn;
        }
        if (line === "## Log" && buffer.length === 0 && messages.length === 0) continue;
        buffer.push(line);
    }
    flush();
    return [...messages, { role: "user", content: clump }];
};

// The emission envelope: what the model emitted at each earlier turn is its assistant message,
// verbatim from the retained emission; each turn's rows (arrivals, receipts, results, whatever
// origin) are the user message that follows; the current turn's rows and the clump close it.
const emissionEnvelope = (user, turn) => {
    const clumpAt = user.indexOf("\n## Worker\n");
    if (clumpAt < 0) throw new Error("recorded packet has no Worker section");
    const clump = user.slice(clumpAt + 1);
    const rowsByTurn = new Map();
    let currentTurn = null;
    for (const line of user.slice(0, clumpAt).split("\n")) {
        const header = /^### log:\/\/\/(\d+)\/(\d+)\/(\d+)\//u.exec(line);
        if (header !== null) currentTurn = Number(header[2]);
        if (currentTurn === null) continue;
        rowsByTurn.set(currentTurn, [...(rowsByTurn.get(currentTurn) ?? []), line]);
    }
    const messages = [];
    for (let t = 1; t <= turn; t += 1) {
        const emission = join(digestDir, `${worker}-1-${t}.assistant.md`);
        if (t < turn && existsSync(emission)) messages.push({ role: "assistant", content: readFileSync(emission, "utf8").trimEnd() });
        const rows = rowsByTurn.get(t);
        if (rows !== undefined) messages.push({ role: "user", content: rows.join("\n").trimEnd() });
    }
    const last = messages.at(-1);
    if (last !== undefined && last.role === "user") last.content = `${last.content}\n\n${clump}`;
    else messages.push({ role: "user", content: clump });
    return messages;
};

// The operator's shapes (2026-09-28). Rows by turn, all origins, from the recorded packet.
const rowsAndClump = (user) => {
    const clumpAt = user.indexOf("\n## Worker\n");
    if (clumpAt < 0) throw new Error("recorded packet has no Worker section");
    const clump = user.slice(clumpAt + 1);
    const rowsByTurn = new Map();
    let currentTurn = null;
    for (const line of user.slice(0, clumpAt).split("\n")) {
        const header = /^### log:\/\/\/(\d+)\/(\d+)\/(\d+)\//u.exec(line);
        if (header !== null) currentTurn = Number(header[2]);
        if (currentTurn === null) continue;
        rowsByTurn.set(currentTurn, [...(rowsByTurn.get(currentTurn) ?? []), line]);
    }
    return { rowsByTurn, clump, log: user.slice(0, clumpAt).trimEnd() };
};
const previousEmission = (turn) => {
    const path = join(digestDir, `${worker}-1-${turn - 1}.assistant.md`);
    return existsSync(path) ? `## Previous Turn Emission\n\n${readFileSync(path, "utf8").trimEnd()}` : null;
};
// lastturn: [user rows 1]…[user rows T-1][assistant emission T-1][user rows T + clump]
const lastTurnEnvelope = (user, turn, causal) => {
    const { rowsByTurn, clump } = rowsAndClump(user);
    const rows = (t) => (rowsByTurn.get(t) ?? []).join("\n").trimEnd();
    const messages = [];
    const upTo = causal ? turn - 2 : turn - 1;
    for (let t = 1; t <= upTo; t += 1) if (rowsByTurn.has(t)) messages.push({ role: "user", content: rows(t) });
    const emission = previousEmission(turn);
    if (emission !== null) messages.push({ role: "assistant", content: emission });
    const tail = [causal && rowsByTurn.has(turn - 1) ? rows(turn - 1) : "", rowsByTurn.has(turn) ? rows(turn) : "", clump].filter((part) => part.length > 0);
    messages.push({ role: "user", content: tail.join("\n\n") });
    return messages;
};
// syslog: [system card + log][assistant emission T-1][user clump]
const systemLogEnvelope = (system, user, turn) => {
    const { clump, log } = rowsAndClump(user);
    const emission = previousEmission(turn);
    return [{ role: "system", content: `${system.trimEnd()}\n\n${log}` }, ...(emission === null ? [] : [{ role: "assistant", content: emission }]), { role: "user", content: clump }];
};

const firstOp = (text) => {
    const m = /```+\s*([A-Za-z0-9_-]+)([^\n]*)/u.exec(text);
    return m === null ? null : `${m[1]}${m[2].trim().length > 0 ? ` ${m[2].trim().split(/\s+/u)[0]}` : ""}`;
};
// A packet echo: the reply continues the packet's own shape instead of answering it.
const echoes = (content) => /^### log:\/\/\/|^## (Log|Worker|Delegation|Open Messages|Context(?: Curation)?)/mu.test(content);
const restarts = (reasoning) => /(understand|analy[sz]e|look at|re-?read|figure out) (the|this) (task|issue|problem|repository|codebase)/iu.test((reasoning ?? "").slice(0, 600));

const cells = [];
for (const turn of turnsArg.split(",").map(Number)) for (const arm of armsArg.split(",")) for (let i = 0; i < samples; i += 1) cells.push({ turn, arm, i });
let next = 0;
const worker_ = async () => {
    while (next < cells.length) {
        const cell = cells[next++];
        const { system, user, recorded } = packet(cell.turn);
        // The operator's line: the rows are receipts the harness writes, never something to emit.
        const RECEIPT_LINE = "\n\nYOU MUST NOT emit log receipts. Valid Plurnk OPs are translated into log receipts.\n";
        const messages = cell.arm === "today"
            ? [{ role: "system", content: system }, { role: "user", content: user }]
            : cell.arm === "turnsline"
                ? [{ role: "system", content: system + RECEIPT_LINE }, ...turnEnvelope(user)]
                : cell.arm === "lastturn"
                    ? [{ role: "system", content: system }, ...lastTurnEnvelope(user, cell.turn, false)]
                    : cell.arm === "lastturn-causal"
                        ? [{ role: "system", content: system }, ...lastTurnEnvelope(user, cell.turn, true)]
                        : cell.arm === "syslog"
                            ? systemLogEnvelope(system, user, cell.turn)
            : cell.arm === "ops"
                ? [{ role: "system", content: system }, ...emissionEnvelope(user, cell.turn)]
                : [{ role: "system", content: system }, ...turnEnvelope(user)];
        const t0 = Date.now();
        let row;
        try {
            const r = await provider.generate({ workerId: `envelope-${cell.arm}-${cell.turn}-${cell.i}`, messages });
            const content = r.assistant?.content ?? "";
            const reasoning = r.assistant?.reasoning ?? "";
            const usage = r.accounting?.[0]?.usage ?? {};
            row = {
                messages: messages.length,
                inputTokens: usage.inputTokens ?? null,
                cachedTokens: usage.inputTokenDetails?.cacheReadTokens ?? null,
                reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? null,
                outputTokens: usage.outputTokens ?? null,
                seconds: Math.round((Date.now() - t0) / 1000),
                restarts: restarts(reasoning),
                echoes: echoes(content),
                firstOp: firstOp(content),
                recordedOp: firstOp(recorded),
                reasoningHead: reasoning.slice(0, 160).replace(/\n/g, " "),
                contentHead: content.slice(0, 400).replace(/\n/g, "⏎"),
            };
            row.match = row.firstOp !== null && row.firstOp === row.recordedOp;
        } catch (error) {
            row = { error: String(error).slice(0, 300) };
        }
        const line = { alias, worker, ...cell, ...row };
        appendFileSync(out, `${JSON.stringify(line)}\n`);
        console.log(JSON.stringify(line).slice(0, 220));
    }
};
await Promise.all(Array.from({ length: concurrency }, worker_));

// Summary: per arm, mean reasoning tokens, restart share, first-op match share.
const rows = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.alias === alias && r.worker === worker && r.error === undefined);
const by = new Map();
for (const r of rows) { const k = r.arm; const a = by.get(k) ?? { n: 0, reasoning: 0, restarts: 0, match: 0, echoes: 0, seconds: 0 }; a.n += 1; a.echoes += r.echoes ? 1 : 0; a.reasoning += r.reasoningTokens ?? 0; a.restarts += r.restarts ? 1 : 0; a.match += r.match ? 1 : 0; a.seconds += r.seconds; by.set(k, a); }
console.log("\narm | samples | mean reasoning tokens | restarts from the task | first op matches recorded | packet echoes | mean seconds");
for (const [arm, a] of by) console.log(`${arm} | ${a.n} | ${Math.round(a.reasoning / a.n)} | ${a.restarts}/${a.n} | ${a.match}/${a.n} | ${a.echoes}/${a.n} | ${Math.round(a.seconds / a.n)}`);
