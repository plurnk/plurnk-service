// {§module-lifecycle} {§module-shutdown-order} {§content-store}
// Boot lifecycle recovery and deadline-bounded daemon shutdown orchestration.

import { readFile } from "node:fs/promises";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db } from "../core/Db.ts";
import type Engine from "../core/Engine.ts";
import type SchemeRegistry from "../core/SchemeRegistry.ts";
import StopDeadline from "../core/StopDeadline.ts";
import Paths from "../Paths.ts";
import Exec from "../schemes/Exec.ts";
import type ClientOperations from "./ClientOperations.ts";
import type DaemonModules from "./DaemonModules.ts";
import type DrainSupervisor from "./DrainSupervisor.ts";
import type Functionality from "./Functionality.ts";
import type Retention from "./Retention.ts";
import type WorkspaceResidency from "./WorkspaceResidency.ts";

export const recoverDaemonLifecycle = async (args: {
    readonly db: Db;
    readonly drains: DrainSupervisor;
    readonly isStarted: () => boolean;
}): Promise<void> => {
    const { db, drains, isStarted } = args;
    await db.recovery_settle_process_owners({});

    const orphanSources = await db.recovery_orphan_message_sources.all<{
        loop_id: number;
        session_id: number;
        origin: string;
    }>({});
    const invalidOrphan = orphanSources.find(({ origin }) => origin !== "model");
    if (invalidOrphan !== undefined) {
        throw new Error(
            `Orphaned provider work belongs to ${invalidOrphan.origin} session ${invalidOrphan.session_id}; only model sessions may enter inference.`,
        );
    }
    for (const source of orphanSources) {
        await drains.reconcileOrphanedMessages(source.session_id, source.loop_id);
    }

    const systemPrompt = await readFile(Paths.instructionsSystem, "utf8"); // {§packet-inject}
    const queued = await db.recovery_queued_sessions.all<{
        session_id: number;
        workspace_id: number;
        origin: string;
    }>({});
    const invalidQueued = queued.find(({ origin }) => origin !== "model");
    if (invalidQueued !== undefined) {
        throw new Error(
            `Queued provider work belongs to ${invalidQueued.origin} session ${invalidQueued.session_id}; only model sessions may enter inference.`,
        );
    }
    const parked = await db.recovery_parked_sessions.all<{
        session_id: number;
        workspace_id: number;
        origin: string;
    }>({});
    const invalidParked = parked.find(({ origin }) => origin !== "model");
    if (invalidParked !== undefined) {
        throw new Error(
            `Parked provider work belongs to ${invalidParked.origin} session ${invalidParked.session_id}; only model sessions may enter inference.`,
        );
    }
    for (const row of queued) {
        const started = await drains.ensureDrain({
            workspaceId: row.workspace_id,
            sessionId: row.session_id,
            systemPrompt,
        });
        started?.drainPromise.catch((err: unknown) => {
            if (isStarted()) {
                console.error(`recovered drain failed for session ${row.session_id}:`, err);
            }
        });
    }
    for (const row of parked) {
        await drains.scheduleWakes(
            row.workspace_id,
            row.session_id,
            systemPrompt,
        );
    }
};

export const stopDaemon = async (args: {
    readonly db: Db;
    readonly engine: Engine;
    readonly drains: DrainSupervisor;
    readonly clientOperations: ClientOperations;
    readonly residency: WorkspaceResidency;
    readonly functionality: Functionality;
    readonly modules: DaemonModules;
    readonly schemes: SchemeRegistry;
    readonly mimetypes: Mimetypes;
    readonly ownsMimetypes: boolean;
    readonly retention: Retention | null;
    readonly deadline?: StopDeadline;
}): Promise<void> => {
    const {
        db,
        engine,
        drains,
        clientOperations,
        residency,
        functionality,
        modules,
        schemes,
        mimetypes,
        ownsMimetypes,
        retention,
        deadline,
    } = args;

    const derivationAbort = new DOMException("daemon stopping", "AbortError");
    retention?.stop();
    engine.cancelAllProposals("daemon_stopping");
    engine.cancelDerivations(derivationAbort);
    drains.beginStop("daemon_stopping");
    clientOperations.beginStop("daemon_stopping");
    residency.beginStop();

    const shutdown = deadline ?? new StopDeadline();

    // Stop accepting external work immediately, but do not await listener
    // closure before cancelling active sessions: an SSE connection may itself be
    // waiting for the session cancellation that follows.
    const modulePhases = modules.beginStop();
    const moduleStop = shutdown.settle("modules stop", () => modulePhases.stop());

    // {§module-shutdown-order} — the settle sequence is DEADLINE-BOUNDED: a child
    // that never closes (a wedged MCP server, a stuck stream) must not hang
    // the daemon forever.
    const drainResult = await shutdown.settle("drains idle", () => drains.idle());
    const clientResult = await shutdown.settle("client operations idle", () => clientOperations.idle());
    const residencyResult = await shutdown.settle("workspace Functionality transitions", () => residency.settle());
    const functionalityResult = await shutdown.settle("functionality publications", () => functionality.settle());
    const moduleStopResult = await moduleStop;
    const streamingResult = await shutdown.settle("streaming schemes idle", async () => {
        const exec = schemes.get("exec");
        if (!(exec instanceof Exec)) return;
        // {§exec-lifetime} — a detached spawn ends with the daemon: nothing else ever aborts it.
        exec.abortDetached();
        await exec.idle();
    });
    const derivationResult = await shutdown.settle("derivation drain", () => engine.drainDerivations(derivationAbort));
    const mimetypeResult = ownsMimetypes
        ? await shutdown.settle("mimetypes dispose", () => mimetypes.dispose())
        : null;
    const schemeResult = await shutdown.settle("schemes close", () => schemes.close());
    const wakeResult = await shutdown.settle("drains idle (wake)", () => drains.idle());
    const moduleCloseResult = await shutdown.settle("modules close", () => modulePhases.close());
    // {§content-store} — the operator's retention runs once more before the statistics.
    const collectResult = await shutdown.settle("retention", async () => retention?.run());
    const optimizeResult = await shutdown.settle("database optimize", () => db.maintenance_optimize.run({}));
    const closeErrors = [
        moduleStopResult,
        moduleCloseResult,
        residencyResult,
        functionalityResult,
        drainResult,
        clientResult,
        streamingResult,
        derivationResult,
        collectResult,
        ...(mimetypeResult === null ? [] : [mimetypeResult]),
        schemeResult,
        wakeResult,
        optimizeResult,
    ]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .flatMap((result) => result.reason instanceof AggregateError
            ? [...result.reason.errors]
            : [result.reason]);
    if (closeErrors.length > 0) throw new AggregateError(closeErrors, "daemon shutdown failed");
};
