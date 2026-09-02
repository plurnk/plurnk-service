// The client read surface: one entry with its channels, and the log projection. Split out of Daemon, which keeps the delegating entry points.
import type { Db } from "../core/Db.ts";
import Engine from "../core/Engine.ts";
import { parsePath, Validator, type ClientEntryChannel, type EntryReadResult } from "@plurnk/plurnk-contracts";
import LogEntry from "./logEntry.ts";
import type { LogEntryWire } from "./logEntry.ts";
import ClientInput from "./client-input.ts";
import Results from "../core/results.ts";
import WorkspaceGate from "../core/WorkspaceGate.ts";
import WorkerResidency from "./WorkerResidency.ts";
import { daemonFailure } from "./daemon-results.ts";
import type { ChannelRow } from "./Daemon.ts";

const entryReadResult = (result: unknown): EntryReadResult =>
    Validator.assertEntryReadResult(result as EntryReadResult);

export default class ClientReads {
    readonly #db: Db;
    readonly #engine: Engine;
    readonly #workspaceGate: WorkspaceGate;
    readonly #residency: WorkerResidency;

    constructor({ db, engine, workspaceGate, residency }: {
        db: Db;
        engine: Engine;
        workspaceGate: WorkspaceGate;
        residency: WorkerResidency;
    }) {
        this.#db = db;
        this.#engine = engine;
        this.#workspaceGate = workspaceGate;
        this.#residency = residency;
    }

    // Contracts {§entry-read-result}: resolve through the scheme's address law,
    // then project one owner-scoped entry without exposing persistence columns.
    async readEntry(args: {
        workspaceId: number;
        workerId: number;
        target: string;
        channel?: string;
        offset?: number;
    }): Promise<EntryReadResult> {
        const workspaceId = ClientInput.assertId("entry.read", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("entry.read", "workerId", args.workerId);
        if (typeof args.target !== "string" || args.target.length === 0) {
            throw daemonFailure(
                "daemon:input",
                "target-invalid",
                400,
                "target is not a non-empty string.",
                {
                    context: "entry.read",
                    field: "target",
                    stage: "input-validation",
                    recovery: "Provide an entry URI.",
                    retryable: false },
            );
        }
        const channel = ClientInput.assertOptionalChannel("entry.read", args.channel);
        const worker = await this.#db.envelope_get_worker_by_id.get<{ workspace_id: number }>({ id: workerId });
        if (worker === undefined) {
            throw daemonFailure(
                "daemon:worker",
                "worker-not-found",
                404,
                `Worker ${workerId} does not exist.`,
                { workerId },
            );
        }
        if (worker.workspace_id !== workspaceId) {
            throw daemonFailure(
                "daemon:worker",
                "workspace-mismatch",
                409,
                `Worker ${workerId} does not belong to workspace ${workspaceId}.`,
                {
                    workerId,
                    workspaceId,
                    actualWorkspaceId: worker.workspace_id,
                    retryable: false },
            );
        }
        const releaseCapabilities = await this.#residency.acquire(workspaceId, workerId);
        let releaseWorkspace: (() => void) | undefined;
        try {
            releaseWorkspace = await this.#workspaceGate.acquireTurn(workspaceId, workerId);
            let parsed;
            try {
                parsed = parsePath(args.target);
            } catch {
                parsed = null;
            }
            if (parsed === null || parsed.kind !== "url") {
                return entryReadResult(Results.failure(
                    "daemon:entry",
                    "target-invalid",
                    400,
                    `The entry target '${args.target}' is not URL-shaped.`,
                    { entry: null },
                    {
                        target: args.target,
                        stage: "entry-read",
                        recovery: "Use a scheme://path target.",
                        retryable: false },
                ));
            }
            if (args.offset !== undefined && channel === undefined) {
                return entryReadResult(Results.failure(
                    "daemon:entry",
                    "offset-channel-required",
                    400,
                    "An entry offset requires a channel.",
                    { entry: null },
                    {
                        offset: args.offset,
                        stage: "entry-read",
                        recovery: "Select the channel to read from the offset.",
                        retryable: false },
                ));
            }
            if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) {
                return entryReadResult(Results.failure(
                    "daemon:entry",
                    "offset-invalid",
                    400,
                    `Entry offset ${args.offset} is not a non-negative safe integer.`,
                    { entry: null },
                    {
                        offset: args.offset,
                        stage: "entry-read",
                        recovery: "Use a non-negative integer offset.",
                        retryable: false },
                ));
            }
            if (parsed.username !== null || parsed.password !== null) {
                return entryReadResult(Results.failure(
                    "daemon:entry",
                    "userinfo-not-allowed",
                    400,
                    "Entry target URL userinfo is not allowed.",
                    { entry: null },
                    {
                        stage: "entry-read",
                        recovery: "Remove credentials from the entry URL.",
                        retryable: false },
                ));
            }
            const location = await this.#engine.resolveEntryAddress({
                workspaceId,
                workerId,
                target: parsed });
            if (location === null) {
                return entryReadResult(Results.failure(
                    "daemon:entry",
                    "entry-not-found",
                    404,
                    "No visible entry exists at the requested target.",
                    { entry: null },
                    { target: args.target },
                ));
            }
            const row = await this.#db.entry_read_lookup.get<{ id: number }>({
                workspace_id: workspaceId,
                owner_id: location.ownerId,
                scheme: location.scheme,
                authority: location.authority,
                pathname: location.pathname });
            if (row === undefined) {
                return entryReadResult(Results.failure(
                    "daemon:entry",
                    "entry-not-found",
                    404,
                    `No visible entry exists at ${location.target}.`,
                    { entry: null },
                    { target: location.target },
                ));
            }
            let channelRows: ChannelRow[];
            if (channel === undefined) {
                channelRows = await this.#db.entry_read_channels.all<ChannelRow>({ entry_id: row.id });
            } else {
                const r = await this.#db.entry_read_channel_slice.get<ChannelRow>({ entry_id: row.id, channel, offset: args.offset ?? 0 });
                if (r === undefined) {
                    const availableChannels = (await this.#db.entry_read_channels.all<ChannelRow>({ entry_id: row.id }))
                        .map(({ name }) => name);
                    return entryReadResult(Results.failure(
                        "daemon:entry",
                        "channel-not-found",
                        404,
                        `Channel #${channel} does not exist at ${location.target}.`,
                        { entry: null },
                        {
                            target: location.target,
                            requestedChannel: channel,
                            availableChannels,
                            ...(availableChannels.length === 0
                                ? {}
                                : { recovery: `Use one of the available channels: ${availableChannels.map((channel) => `#${channel}`).join(", ")}.` }),
                            retryable: false },
                    ));
                }
                channelRows = [r];
            }
            const channels: Record<string, ClientEntryChannel> = {};
            for (const c of channelRows) {
                channels[c.name] = {
                    content: c.content,
                    contentOffset: c.contentOffset,
                    contentLength: c.contentLength,
                    mimetype: c.mimetype,
                    weight: c.weight,
                    state: c.state };
            }
            return entryReadResult({
                status: 200,
                entry: {
                    entryId: row.id,
                    target: location.target,
                    channels } });
        } finally {
            releaseWorkspace?.();
            releaseCapabilities();
        }
    }


    // {§methods-log-read} — a workspace's journal, the module's primary render input. The worker is
    // ownership-verified against the workspace (a workspace reads only its own workers — the model worker included,
    // {§methods-log-coordinate}); entries filter by loop/turn/since-id or the full L/T/S display coordinate. Core owns the
    // journal + the invariant; the module shapes the entries into AG-UI messages at its edge.
    async readLog(args: {
        workspaceId: number; workerId: number;
        loopId?: number; turnId?: number; sinceId?: number; limit?: number;
        loopSeq?: number; turnSeq?: number; sequence?: number;
    }): Promise<LogEntryWire[]> {
        const workspaceId = ClientInput.assertId("log.read", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("log.read", "workerId", args.workerId);
        const target = await this.#db.envelope_get_worker_by_id.get<{ workspace_id: number }>({ id: workerId });
        if (target === undefined) {
            throw daemonFailure(
                "daemon:worker",
                "worker-not-found",
                404,
                `Worker ${workerId} does not exist.`,
                { workerId },
            );
        }
        if (target.workspace_id !== workspaceId) {
            throw daemonFailure(
                "daemon:worker",
                "workspace-mismatch",
                409,
                `Worker ${workerId} does not belong to workspace ${workspaceId}.`,
                {
                    workerId,
                    workspaceId,
                    actualWorkspaceId: target.workspace_id,
                    retryable: false },
            );
        }
        const coordinateFields = {
            loopId: args.loopId,
            turnId: args.turnId,
            sinceId: args.sinceId,
            loopSeq: args.loopSeq,
            turnSeq: args.turnSeq,
            sequence: args.sequence };
        for (const [field, value] of Object.entries(coordinateFields)) {
            if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
                throw daemonFailure(
                    "daemon:log",
                    "coordinate-invalid",
                    400,
                    `Log coordinate field '${field}' is not a non-negative safe integer.`,
                    {
                        field,
                        value,
                        stage: "log-read",
                        recovery: "Use a non-negative integer coordinate.",
                        retryable: false },
                );
            }
        }
        if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1)) {
            throw daemonFailure(
                "daemon:log",
                "limit-invalid",
                400,
                `Log limit ${args.limit} is not a positive safe integer.`,
                {
                    field: "limit",
                    value: args.limit,
                    stage: "log-read",
                    recovery: "Use a positive integer log limit.",
                    retryable: false },
            );
        }
        const rows = await this.#db.log_read_recent_ids.all<{ id: number }>({
            worker_id: workerId,
            loop_id: args.loopId ?? null, turn_id: args.turnId ?? null, since_id: args.sinceId ?? null,
            loop_seq: args.loopSeq ?? null, turn_seq: args.turnSeq ?? null, sequence: args.sequence ?? null,
            limit: Math.min(args.limit ?? 100, 1000) });
        const entries: LogEntryWire[] = [];
        for (const r of rows) entries.push(await LogEntry.fetchLogEntry(this.#db, r.id));
        return entries;
    }

}
