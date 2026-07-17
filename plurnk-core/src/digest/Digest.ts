#!/usr/bin/env node
//
// Run-digest tool for plurnk-service DBs. Reads a sqlite plurnk*.db and
// emits per-worker forensic artifacts to test/digest/. First-order forensic
// surface; read-only; safe to re-run.
//
//   test/digest/digest.md           Health triage rollup (clean/degenerate-win/failed loops) +
//                                   run-shape header + waterfall (per-loop health verdict; per-turn:
//                                   status, ⚠ errs=N, model emission summary, indented op list)
//   test/digest/digest.json         Same data, machine-queryable
//   test/digest/reasoning.md        Per-turn reasoning text (full)
//   test/digest/packetNNN.system.md       BYTE-FOR-BYTE the system message the LLM
//                                         received on TURN N (0-based). Turn 0 is the
//                                         plurnk doc-materialization / setup turn (no model
//                                         packet — a one-line note); the model's turns are
//                                         Turn 1, 2, … (packet001, packet002, …).
//   test/digest/packetNNN.user.md         Same for the user message.
//   test/digest/packetNNN.assistant.md     Model emission (content string).
//   test/digest/packetNNN.assistantRaw.json  Opaque provider response.
//
// packet files are byte-identical to what Engine emits, because Engine and
// digest both project through PacketWire (one renderer, no drift).
//
// SQL lives in the co-located digest.sql; opened the sqlrite way (SqlRiteSync,
// the sync CLI/script facade). Each PREP block is read through its own accessor.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import SqlRiteSync from "@possumtech/sqlrite/sync";
import PacketWire from "../core/packet-wire.ts";
import ProviderInstantiate from "../core/ProviderInstantiate.ts";
import type { ChatMessage } from "@plurnk/plurnk-providers";

// The requiem prompt (#requiem): the model's exit interview. Absolution up front — the system is
// under test, not the model — so RLHF'd self-blame doesn't crowd out the system indictment. The
// operator's wording, one absolution sentence added.
const REQUIEM_PROMPT = "This worker was a test of the Plurnk System. The system is under test, not you — any faults you encountered are defects in the system's design or documentation, and cataloguing them is the task, never a criticism of your performance. Please numerically list all of the errors, issues, and ambiguities you encountered in the Plurnk System while attempting to perform your tasks.";

// DB row shapes — only the columns this tool reads. JSON columns (packet,
// flags, tx, rx) arrive as strings, parsed on use.
interface WorkspaceRow { id: number; name: string; cost_pico: number }
interface WorkerRow { id: number; workspace_id: number; name: string; cost_pico: number }
interface LoopRow { id: number; worker_id: number; sequence: number; status: number; prompt: string; flags: string }
interface TurnRow {
    id: number; loop_id: number; sequence: number; status: number; packet: string;
    usage_prompt: number; usage_completion: number; usage_cached: number; usage_cost_pico: number;
    finish_reason: string | null; model: string | null;
    meta: string | null;  // #498 — provider passthrough (timings, railsAttached/railsVerdict); digest consumers need rail truth
}
interface LogRow {
    id: number; turn_id: number; sequence: number;
    op: string; scheme: string | null; pathname: string | null;
    rx: string | null; status_rx: number; state: string; outcome: string | null;
}
interface WorkerRollupRow {
    worker_id: number; loops: number; turns: number;
    total_prompt: number; total_completion: number; total_cached: number; total_cost_pico: number;
    last_status: number | null;
}
interface OpMixRow { worker_id: number; op: string; n: number }

// The SqlRiteSync handle's type (sync per-PREP accessors) is declared in
// src/types/sqlrite.d.ts; digest reads each block through its own accessor.

// Loaded snapshot + derived index maps, threaded through the renderers so the
// data flow is explicit (no hidden module-level state).
interface DigestModel {
    dbPath: string;
    digestDir: string;
    workspaces: WorkspaceRow[];
    workers: WorkerRow[];
    loops: LoopRow[];
    turns: TurnRow[];
    logEntries: LogRow[];
    workersByWorkspace: Map<number, WorkerRow[]>;
    loopsByWorker: Map<number, LoopRow[]>;
    turnsByLoop: Map<number, TurnRow[]>;
    logEntriesByTurn: Map<number, LogRow[]>;
    loopsById: Map<number, LoopRow>;
    workersById: Map<number, WorkerRow>;
    workerRollups: Map<number, WorkerRollupRow>;
    opMixByWorker: Map<number, OpMixRow[]>;
    embeddings: { entries: number; entries_embedded: number; chunk_rows: number; models: number; token_derivations: number };
}

// Programmatic entry options (#264 — plurnk-bench reuses Digest without the CLI).
// dbPath is required; digestDir defaults to the bin's test/digest; an optional
// workerId/workspaceId narrows the digest to one scope instead of the whole DB.
interface DigestOptions {
    dbPath: string;
    digestDir?: string;
    workerId?: number;
    workspaceId?: number;
}

export default class Digest {
    static #summarize(text: unknown, n = 80): string {
        if (text === null || text === undefined) return "";
        const flat = String(text).replace(/\s+/g, " ").trim();
        if (flat.length <= n) return flat;
        return `${flat.slice(0, n)}…`;
    }

    static #parseJson(s: unknown, fallback: unknown = null): unknown {
        if (s === null || s === undefined) return fallback;
        try { return JSON.parse(String(s)); } catch { return fallback; }
    }

    static #renderOpLine(le: LogRow): string {
        const target = le.scheme !== null && le.pathname !== null
            ? `${le.scheme}://${le.pathname}`
            : le.pathname ?? "—";
        const state = le.state !== "resolved" ? ` state=${le.state}` : "";
        const outcome = le.outcome !== null ? ` outcome=${le.outcome}` : "";
        const fail = le.status_rx >= 400 ? " ✗" : "";
        // For non-2xx outcomes, surface the error string (or body) from rx so
        // the waterfall explains WHY each failure happened without opening packets.
        let errLine = "";
        if (le.status_rx >= 400) {
            const rx = Digest.#parseJson(le.rx, {}) as { error?: unknown; body?: unknown };
            const msg = rx.error ?? rx.body ?? null;
            if (typeof msg === "string" && msg.length > 0) {
                errLine = `\n    → ${Digest.#summarize(msg, 140)}`;
            }
        }
        return `  ← ${le.op}[${le.status_rx}] ${target}${state}${outcome}${fail}${errLine}`;
    }

    // The "degenerate win" lens (owner ask): a loop's health = how many errors/strikes it earned
    // vs whether it still concluded. A green that limped across on 16 errors is a FAILING artifact
    // wearing a passing badge; the digest must make that impossible to miss. errors = ≥400 op rows;
    // errorItems = minted op='error' rows (truncation/budget/steer/cycle — the strike signals).
    static #loopHealth(loop: LoopRow, m: DigestModel): { errors: number; errorItems: number; verdict: string } {
        let errors = 0;
        let errorItems = 0;
        for (const t of m.turnsByLoop.get(loop.id) ?? []) {
            for (const le of m.logEntriesByTurn.get(t.id) ?? []) {
                if (le.status_rx >= 400) errors += 1;
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
        const packet = Digest.#parseJson(turn.packet, {}) as { assistant?: { content?: unknown; reasoning?: unknown } };
        const assistant = packet.assistant ?? {};
        const content = typeof assistant.content === "string" ? assistant.content : "";
        const reasoning = typeof assistant.reasoning === "string" ? assistant.reasoning : null;
        const tokens = `prompt=${turn.usage_prompt} completion=${turn.usage_completion} cached=${turn.usage_cached}`;
        const cost = turn.usage_cost_pico > 0 ? ` cost=$${(turn.usage_cost_pico / 1e12).toFixed(6)}` : "";
        const finishReason = turn.finish_reason ?? "—";
        // #498 — rail truth on the human line: attached+ok stays quiet-positive; anything else shouts.
        const tm = Digest.#parseJson(turn.meta ?? "null", null) as { railsAttached?: boolean; railsVerdict?: string } | null;
        const rails = tm?.railsAttached === undefined ? "" : ` rails=${tm.railsAttached ? (tm.railsVerdict ?? "attached") : "OFF"}`;
        const model = turn.model ?? "—";
        const errs = (m.logEntriesByTurn.get(turn.id) ?? []).filter((le) => le.status_rx >= 400).length;
        const errBadge = errs > 0 ? `  ⚠ errs=${errs}` : "";
        const head = `T${turn.sequence}: status=${turn.status} finish=${finishReason}${rails} model=${model} ${tokens}${cost}${errBadge}`;
        const summary = content.length > 0 ? `  ↳ emission: ${Digest.#summarize(content, 100)}` : `  ↳ emission: (empty)`;
        const reasoningLine = reasoning && reasoning.length > 0
            ? `  ↳ reasoning: ${Digest.#summarize(reasoning, 100)}`
            : null;
        const opLines = (m.logEntriesByTurn.get(turn.id) ?? []).map((le) => Digest.#renderOpLine(le));
        return [head, summary, ...(reasoningLine ? [reasoningLine] : []), ...opLines].join("\n");
    }

    static #renderWorkerShape(worker: WorkerRow, m: DigestModel): string {
        // every worker has exactly one rollup row — digest_worker_rollups is FROM workers
        const roll = m.workerRollups.get(worker.id)!;
        const opMix = (m.opMixByWorker.get(worker.id) ?? []).map((o) => `${o.op}=${o.n}`).join(" ");
        const costStr = roll.total_cost_pico > 0 ? `$${(roll.total_cost_pico / 1e12).toFixed(6)}` : "$0";
        return [
            `Loops:      ${roll.loops}`,
            `Turns:      ${roll.turns}`,
            `Last turn:  ${roll.last_status !== null ? `status=${roll.last_status}` : "(none)"}`,
            `Tokens:     prompt=${roll.total_prompt} completion=${roll.total_completion} cached=${roll.total_cached}`,
            `Cost:       ${costStr} (DB rollup workers.cost_pico=${worker.cost_pico})`,
            `Op mix:     ${opMix.length > 0 ? opMix : "(no ops)"}`,
        ].join("\n");
    }

    static #renderWaterfall(m: DigestModel): string {
        const lines: string[] = [];
        lines.push(`# plurnk-service digest`);
        lines.push("");
        lines.push(`DB: ${m.dbPath}`);
        lines.push(`Workspaces: ${m.workspaces.length}  Runs: ${m.workers.length}  Loops: ${m.loops.length}  Turns: ${m.turns.length}  Log entries: ${m.logEntries.length}`);
        lines.push(`Semantic:  entries=${m.embeddings.entries} embedded=${m.embeddings.entries_embedded} chunks=${m.embeddings.chunk_rows} models=${m.embeddings.models} token-derivations=${m.embeddings.token_derivations}`);
        // Triage rollup up top: how many conversations limped vs died vs ran clean, and the total
        // error/strike load. The whole point of the "degenerate win" lens — see it before scrolling.
        const health = m.loops.map((l) => Digest.#loopHealth(l, m));
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
                lines.push(Digest.#renderWorkerShape(worker, m));
                lines.push("```");
                const workerLoops = m.loopsByWorker.get(worker.id) ?? [];
                for (const loop of workerLoops) {
                    lines.push("");
                    const h = Digest.#loopHealth(loop, m);
                    const badge = h.verdict === "CLEAN"
                        ? " — CLEAN"
                        : ` — ${h.verdict === "DEGENERATE-WIN" ? "⚠ DEGENERATE-WIN" : h.verdict} (${h.errors} errors, ${h.errorItems} error-items)`;
                    lines.push(`#### Loop ${loop.sequence} (id=${loop.id}, status=${loop.status})${badge}`);
                    lines.push("");
                    lines.push(`Prompt: ${Digest.#summarize(loop.prompt, 160)}`);
                    const flags = Digest.#parseJson(loop.flags, {}) as Record<string, unknown>;
                    const flagSummary = Object.entries(flags).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ");
                    if (flagSummary.length > 0) lines.push(`Flags: ${flagSummary}`);
                    lines.push("");
                    lines.push("```");
                    for (const t of m.turnsByLoop.get(loop.id) ?? []) lines.push(Digest.#renderTurnLine(t, m));
                    lines.push("```");
                }
            }
        }
        return lines.join("\n");
    }

    static #renderReasoning(m: DigestModel): string {
        const lines: string[] = [];
        lines.push(`# plurnk-service reasoning`);
        lines.push("");
        lines.push("Per-turn reasoning_content extracted from turns.packet.assistant.reasoning.");
        for (const t of m.turns) {
            const loop = m.loopsById.get(t.loop_id);
            const worker = loop ? m.workersById.get(loop.worker_id) : undefined;
            const packet = Digest.#parseJson(t.packet, {}) as { assistant?: { reasoning?: unknown } };
            const reasoning = packet.assistant?.reasoning ?? null;
            lines.push("");
            lines.push(`## Worker ${worker?.id ?? "?"} / Loop ${loop?.sequence ?? "?"} / Turn ${t.sequence} (id=${t.id})`);
            lines.push("");
            if (typeof reasoning === "string" && reasoning.length > 0) lines.push(reasoning);
            else lines.push("(no reasoning_content)");
        }
        return lines.join("\n");
    }

    // Per-turn packet files, byte-identical to the wire (Engine and digest both
    // project through PacketWire). system/user are markdown; assistantRaw is JSON.
    static #writePacketFiles(m: DigestModel): string[] {
        const written: string[] = [];
        // 0-based TURN index, NOT the DB id: Turn 0 is the plurnk doc-materialization
        // (setup) turn; the model's turns are Turn 1, 2, …, so the model's first packet is
        // packet001 — not packet002-by-id. id-sorted so the index is chronological.
        m.turns.toSorted((a, b) => a.id - b.id).forEach((t, index) => {
            const packet = Digest.#parseJson(t.packet, {}) as {
                sections?: unknown; assistant?: { content?: unknown }; assistantRaw?: unknown;
            };
            const sections = (Array.isArray(packet.sections) ? packet.sections : []) as Parameters<typeof PacketWire.renderSlot>[0];
            const padded = String(index).padStart(3, "0");
            if (sections.length === 0) {
                // No assembled packet — the setup turn dispatches its doc EDITs without one.
                // Write ONE labeled note rather than four blank files, so opening Turn 0 reads
                // as "setup," not "the packet is empty, where is it?".
                const note = `# Turn ${index} — setup, no model packet\n\nThe plurnk doc-materialization run dispatched its ops (the scheme/exec docs) without assembling a model packet. The model's first packet is Turn 1 — packet001. See digest.md for this turn's ops.\n`;
                writeFileSync(join(m.digestDir, `packet${padded}.system.md`), note);
                written.push(`packet${padded}.system.md`);
                return;
            }
            const systemMd = PacketWire.renderSlot(sections, "system");
            const userMd = PacketWire.renderSlot(sections, "user");
            const assistantText = typeof packet.assistant?.content === "string" ? packet.assistant.content : "";
            const assistantRawJson = JSON.stringify(packet.assistantRaw ?? null, null, 2);
            const files: Array<[string, string]> = [
                [`packet${padded}.system.md`, systemMd],
                [`packet${padded}.user.md`, userMd],
                [`packet${padded}.assistant.md`, assistantText],
                [`packet${padded}.assistantRaw.json`, assistantRawJson],
            ];
            for (const [file, body] of files) {
                writeFileSync(join(m.digestDir, file), body);
                written.push(file);
            }
        });
        return written;
    }

    static #renderJson(m: DigestModel): string {
        return JSON.stringify({
            dbPath: m.dbPath,
            workspaces: m.workspaces.map((s) => ({ id: s.id, name: s.name, cost_pico: s.cost_pico })),
            workers: m.workers.map((r) => ({ id: r.id, workspace_id: r.workspace_id, name: r.name, cost_pico: r.cost_pico })),
            loops: m.loops.map((l) => ({
                id: l.id, worker_id: l.worker_id, sequence: l.sequence, status: l.status,
                prompt: l.prompt, flags: Digest.#parseJson(l.flags, {}),
            })),
            turns: m.turns.map((t) => ({
                id: t.id, loop_id: t.loop_id, sequence: t.sequence, status: t.status,
                usage_prompt: t.usage_prompt, usage_completion: t.usage_completion,
                usage_cached: t.usage_cached, usage_cost_pico: t.usage_cost_pico,
                finish_reason: t.finish_reason, model: t.model,
                // #498 — the raw provider meta (timings + railsAttached/railsVerdict): rail truth for
                // aggregate tooling, and the speculative-decode stats the #488 fingerprint needed.
                meta: Digest.#parseJson(t.meta ?? "null", null),
            })),
            log_entries: m.logEntries.map((le) => ({
                id: le.id, turn_id: le.turn_id, sequence: le.sequence,
                op: le.op, target: `${le.scheme ?? ""}://${le.pathname ?? ""}`,
                status_rx: le.status_rx, state: le.state, outcome: le.outcome,
            })),
        }, null, 2);
    }

    // Default DB path — mirrors the service (`Service.#expandHome(PLURNK_SERVICE_DB_PATH)`; the
    // `.env.defaults` floor is `~/.plurnk/plurnk.db`). The old repo-local default broke when
    // the DB moved to `~/.plurnk`; a no-arg digest now reads the service's actual DB.
    static defaultDbPath(): string {
        const env = process.env.PLURNK_SERVICE_DB_PATH;
        if (env !== undefined && env.length > 0) {
            if (env === "~") return homedir();
            return env.startsWith("~/") ? resolve(homedir(), env.slice(2)) : env;
        }
        return resolve(homedir(), ".plurnk", "plurnk.db");
    }

    // The requiem (#requiem): the model's OWN exit interview, the one reader in the correct epistemic
    // position (it has none of our context about what the packet is "supposed" to mean). Reconstructs
    // each worker's final packet from the stored sections (byte-identical to what the model saw), appends
    // its last emission + the requiem prompt, and calls the provider UNCONSTRAINED (no grammar — free
    // prose, or the leash would distort the testimony). One requiem per worker (workers included).
    // Fail-hard on no provider: testimony with no witness is an error, not a skip.
    static async requiem(opts: DigestOptions & { signal?: AbortSignal }): Promise<{ path: string; workers: number }> {
        const dbPath = resolve(opts.dbPath);
        if (!existsSync(dbPath)) throw new Error(`digest: no DB at ${dbPath}`);
        const digestDir = opts.digestDir ?? join(process.cwd(), "test", "digest");
        mkdirSync(digestDir, { recursive: true });

        const provider = await ProviderInstantiate.loadActiveProvider();
        if (provider === null) throw new Error("requiem: no active provider — set PLURNK_MODEL; a requiem needs a witness to testify");

        const moduleDir = dirname(fileURLToPath(import.meta.url));
        const db = new SqlRiteSync({ path: dbPath, dir: [moduleDir] });
        const workers = db.digest_workers.all<WorkerRow>();
        const loopById = new Map(db.digest_loops.all<LoopRow>().map((l) => [l.id, l]));

        // Each worker's turns that carry a MODEL packet (non-empty sections — setup/plurnk turns have none),
        // ordered; the last is the worker's final context. A worker with no model packet (client/plurnk) is silent.
        const byWorker = new Map<number, Array<{ loopSeq: number; turnSeq: number; sections: Parameters<typeof PacketWire.renderSlot>[0]; assistant: string }>>();
        for (const t of db.digest_turns.all<TurnRow>()) {
            const loop = loopById.get(t.loop_id);
            if (loop === undefined) continue;
            const packet = Digest.#parseJson(t.packet, {}) as { sections?: unknown; assistant?: { content?: unknown } };
            const sections = (Array.isArray(packet.sections) ? packet.sections : []) as Parameters<typeof PacketWire.renderSlot>[0];
            if (sections.length === 0) continue;
            const arr = byWorker.get(loop.worker_id) ?? [];
            arr.push({ loopSeq: loop.sequence, turnSeq: t.sequence, sections, assistant: typeof packet.assistant?.content === "string" ? packet.assistant.content : "" });
            byWorker.set(loop.worker_id, arr);
        }

        const out: string[] = [
            "# plurnk-service requiem",
            "",
            "The model's own exit interview: each worker's FINAL packet + its last emission, then the requiem",
            "prompt, answered UNCONSTRAINED (no grammar). The model is the only reader without our context",
            "about what the packet is supposed to mean. Testimony, NOT a bug list — most items are the model",
            "chafing at discipline it is meant to chafe at (§filter-model-audit-findings); the signal is the",
            "recurring, specific complaint across many requiems. Triage adversarially.",
            "",
        ];
        for (const worker of workers) {
            const entries = byWorker.get(worker.id);
            if (entries === undefined || entries.length === 0) continue;
            entries.sort((a, b) => a.loopSeq - b.loopSeq || a.turnSeq - b.turnSeq);
            const last = entries[entries.length - 1];
            const messages: ChatMessage[] = [
                { role: "system", content: PacketWire.renderSlot(last.sections, "system") },
                { role: "user", content: PacketWire.renderSlot(last.sections, "user") },
                ...(last.assistant.length > 0 ? [{ role: "assistant" as const, content: last.assistant }] : []),
                { role: "user", content: REQUIEM_PROMPT },
            ];
            // Generous budget: a reasoning model spends the reasoning channel BEFORE emitting content;
            // 4096 total left content empty (finish=length) on ~40% of a real sweep, and 16384 still
            // starved a heavy thinker (#373). One escalation retry doubles the room; a worker whose
            // testimony is STILL empty records the reasoning spend honestly instead of a bare shrug.
            let resp = await provider.generate({ messages, workerId: String(worker.id), maxTokens: 16384, ...(opts.signal !== undefined ? { signal: opts.signal } : {}) });
            if (resp.assistant.content.trim() === "" && resp.assistant.finishReason === "length") {
                resp = await provider.generate({ messages, workerId: String(worker.id), maxTokens: 32768, ...(opts.signal !== undefined ? { signal: opts.signal } : {}) });
            }
            const testimony = resp.assistant.content.trim()
                || `(no testimony — ${resp.assistant.usage.completion} tokens consumed entirely by reasoning, even after the 32768-token retry)`;
            out.push(`## Worker #${worker.id} — ${worker.name}`, "", `_(${resp.assistant.finishReason ?? "?"}, ${resp.assistant.usage.completion} tok)_`, "", testimony, "");
        }

        const path = join(digestDir, "requiem.md");
        writeFileSync(path, out.join("\n"));
        return { path, workers: byWorker.size };
    }

    static run(opts: DigestOptions): void {
        // digest.sql is packaged beside this module (src/digest → dist/digest via copy-sql),
        // so SqlRiteSync resolves it from node_modules in a published install too (#303).
        const moduleDir = dirname(fileURLToPath(import.meta.url));
        const dbPath = resolve(opts.dbPath);
        if (!existsSync(dbPath)) throw new Error(`digest: no DB at ${dbPath}`);
        // A consumer (plurnk-bench) passes an explicit per-trial digestDir; the CLI default is cwd/test/digest.
        const digestDir = opts.digestDir ?? join(process.cwd(), "test", "digest");

        // Opens without readOnly so WAL-mode DBs (the daemon's normal operating
        // mode) inspect cleanly; this tool only reads. The DB is quiescent at
        // digest time, so each PREP reads on its own — no cross-query snapshot.
        const db = new SqlRiteSync({ path: dbPath, dir: [moduleDir] });
        let workspaces = db.digest_workspaces.all<WorkspaceRow>();
        let workers = db.digest_workers.all<WorkerRow>();
        let loops = db.digest_loops.all<LoopRow>();
        let turns = db.digest_turns.all<TurnRow>();
        let logEntries = db.digest_log_entries.all<LogRow>();
        let workerRollupRows = db.digest_worker_rollups.all<WorkerRollupRow>();
        let opMixRows = db.digest_worker_op_mix.all<OpMixRow>();
        // The semantic-state analytic (owner ask), feature-detected per table: a HISTORICAL
        // specimen may predate token_counts/entry_embeddings — an old db is a fact to read,
        // not a contract violation. Absent tables read as -1. node:sqlite directly (SqlRite's
        // eager prepare would refuse the whole open over one missing optional table).
        const probe = new DatabaseSync(dbPath, { readOnly: true });
        const has = (t: string): boolean => probe.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t) !== undefined;
        const one = (q: string): number => Number((probe.prepare(q).get() as { n: number }).n);
        const embeddings = {
            entries: has("entries") ? one("SELECT count(*) n FROM entries") : -1,
            entries_embedded: has("entry_embeddings") ? one("SELECT count(DISTINCT entry_id) n FROM entry_embeddings") : -1,
            chunk_rows: has("entry_embeddings") ? one("SELECT count(*) n FROM entry_embeddings") : -1,
            models: has("entry_embeddings") ? one("SELECT count(DISTINCT embedding_model) n FROM entry_embeddings") : -1,
            token_derivations: has("token_counts") ? one("SELECT count(*) n FROM token_counts") : -1,
        };
        probe.close();
        db.close();

        // Optional run/workspace selector — narrow to one worker or workspace; everything
        // cascades from the kept workers (loops→turns→log entries→rollups), so a consumer
        // (plurnk-bench) digests just the scope it cares about, not the whole DB. #264.
        if (opts.workerId !== undefined) workers = workers.filter((r) => r.id === opts.workerId);
        if (opts.workspaceId !== undefined) workers = workers.filter((r) => r.workspace_id === opts.workspaceId);
        if (opts.workerId !== undefined || opts.workspaceId !== undefined) {
            const keptWorkerIds = new Set(workers.map((r) => r.id));
            const keptWorkspaceIds = new Set(workers.map((r) => r.workspace_id));
            workspaces = workspaces.filter((s) => keptWorkspaceIds.has(s.id));
            loops = loops.filter((l) => keptWorkerIds.has(l.worker_id));
            const keptLoopIds = new Set(loops.map((l) => l.id));
            turns = turns.filter((t) => keptLoopIds.has(t.loop_id));
            const keptTurnIds = new Set(turns.map((t) => t.id));
            logEntries = logEntries.filter((le) => keptTurnIds.has(le.turn_id));
            workerRollupRows = workerRollupRows.filter((r) => keptWorkerIds.has(r.worker_id));
            opMixRows = opMixRows.filter((o) => keptWorkerIds.has(o.worker_id));
        }

        // Wipe-then-recreate the digest dir so each worker is a clean snapshot —
        // orphaned packet*.* files from a prior run don't linger.
        rmSync(digestDir, { recursive: true, force: true });
        mkdirSync(digestDir, { recursive: true });

        const workersByWorkspace = new Map<number, WorkerRow[]>();
        for (const r of workers) { const arr = workersByWorkspace.get(r.workspace_id) ?? []; arr.push(r); workersByWorkspace.set(r.workspace_id, arr); }
        const loopsByWorker = new Map<number, LoopRow[]>();
        for (const l of loops) { const arr = loopsByWorker.get(l.worker_id) ?? []; arr.push(l); loopsByWorker.set(l.worker_id, arr); }
        const turnsByLoop = new Map<number, TurnRow[]>();
        for (const t of turns) { const arr = turnsByLoop.get(t.loop_id) ?? []; arr.push(t); turnsByLoop.set(t.loop_id, arr); }
        const logEntriesByTurn = new Map<number, LogRow[]>();
        for (const le of logEntries) { const arr = logEntriesByTurn.get(le.turn_id) ?? []; arr.push(le); logEntriesByTurn.set(le.turn_id, arr); }
        const loopsById = new Map(loops.map((l) => [l.id, l]));
        const workersById = new Map(workers.map((r) => [r.id, r]));
        const workerRollups = new Map(workerRollupRows.map((r) => [r.worker_id, r]));
        const opMixByWorker = new Map<number, OpMixRow[]>();
        for (const o of opMixRows) { const arr = opMixByWorker.get(o.worker_id) ?? []; arr.push(o); opMixByWorker.set(o.worker_id, arr); }

        const m: DigestModel = {
            dbPath, digestDir, workspaces, workers, loops, turns, logEntries,
            workersByWorkspace, loopsByWorker, turnsByLoop, logEntriesByTurn, loopsById, workersById,
            workerRollups, opMixByWorker, embeddings,
        };

        writeFileSync(join(digestDir, "digest.md"), Digest.#renderWaterfall(m));
        writeFileSync(join(digestDir, "digest.json"), Digest.#renderJson(m));
        writeFileSync(join(digestDir, "reasoning.md"), Digest.#renderReasoning(m));
        const packetFiles = Digest.#writePacketFiles(m);
        const packetIds = [...new Set(packetFiles.map((f) => f.slice(0, f.indexOf("."))))];

        console.log(`digest: wrote ${digestDir}/{digest.md,digest.json,reasoning.md} + ${packetFiles.length} packet section files (${packetIds.join(", ") || "none"})`);
        console.log(`  source: ${dbPath}`);
        console.log(`  workspaces=${workspaces.length} workers=${workers.length} loops=${loops.length} turns=${turns.length} log_entries=${logEntries.length}`);
    }
}
