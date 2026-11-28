import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe, type TestContext } from "node:test";
import {
    APPLICATION_RUNTIME_STREAM_EVENTS,
    DAEMON_NOTIFICATION_EVENTS,
    Validator,
    createWatchState,
    projectWatchOverview,
    reduceWatchNotification,
    type DaemonNotification,
    type DaemonNotificationStreamEnvelope,
    type NotificationsResyncPayload,
    type NotificationsSnapshotPayload,
} from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import NotificationsEndpoint from "../../src/server/NotificationsEndpoint.ts";
import { ownSession, TEST_OWNER } from "./_approval.ts";
import { openMigrated } from "./_db.ts";
import { bindListener } from "./_http.ts";
import { makeMockResponse } from "./_mock.ts";
import { viableWindow } from "./_provider.ts";
import { waitFor } from "./_rpc.ts";

interface SseFrame {
    readonly id: string | null;
    readonly event: string;
    readonly envelope: DaemonNotificationStreamEnvelope;
}

const openSse = async (
    t: TestContext,
    port: number,
    suffix = "",
    headers: Readonly<Record<string, string>> = {},
) => {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/notifications${suffix}`, {
        headers: { accept: "text/event-stream", ...headers },
        signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");

    const frames: SseFrame[] = [];
    const notifications: DaemonNotification[] = [];
    const snapshots: NotificationsSnapshotPayload[] = [];
    const resyncs: NotificationsResyncPayload[] = [];
    const firstFrame = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();

    const reader = (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        try {
            for await (const chunk of res.body!) {
                buffer += decoder.decode(chunk, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";
                for (const raw of parts) {
                    if (raw.startsWith(":")) {
                        firstFrame.resolve();
                        continue;
                    }
                    let id: string | null = null;
                    let event = "message";
                    let dataText: string | null = null;
                    for (const line of raw.split("\n")) {
                        if (line.startsWith("id: ")) id = line.slice(4);
                        else if (line.startsWith("event: ")) event = line.slice(7);
                        else if (line.startsWith("data: ")) dataText = line.slice(6);
                    }
                    if (dataText === null) continue;
                    // Every SSE frame (including notifications/snapshot and notifications/resync) validates against DaemonNotificationEnvelope.json!
                    const validated = Validator.assertDaemonNotification(
                        JSON.parse(dataText),
                    ) as DaemonNotificationStreamEnvelope;
                    assert.equal(validated.event, event);
                    frames.push({ id, event, envelope: validated });
                    if (validated.event === "notifications/snapshot") {
                        snapshots.push(validated.data);
                    } else if (validated.event === "notifications/resync") {
                        resyncs.push(validated.data);
                    } else {
                        notifications.push(validated);
                    }
                    firstFrame.resolve();
                }
            }
        } catch (error) {
            if (!controller.signal.aborted) throw error;
        } finally {
            closed.resolve();
        }
    })();
    t.after(async () => {
        controller.abort();
        await reader;
    });

    await firstFrame.promise;
    return {
        frames,
        notifications,
        snapshots,
        resyncs,
        closed: closed.promise,
        close: async () => {
            controller.abort();
            await reader;
        },
    };
};

describe("Notifications matrix, Watch homomorphism, and replay", () => {
    test(
        "{§notifications} {§http-host} {§application-session-observation} all 19 discrete notification events and notifications/snapshot validate against DaemonNotificationEnvelope, maintain Watch homomorphism with SQLite overview, respect scoping, and keep log/entry on runtime stream",
        { timeout: 30_000 },
        async (t) => {
            const previousPersona = process.env.PLURNK_PERSONAS_reviewer;
            const previousOptimistic = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
            process.env.PLURNK_PERSONAS_reviewer = JSON.stringify({
                description: "Matrix reviewer persona",
                body: "Review code concisely.",
            });
            process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "0";
            t.after(() => {
                if (previousPersona === undefined) delete process.env.PLURNK_PERSONAS_reviewer;
                else process.env.PLURNK_PERSONAS_reviewer = previousPersona;
                if (previousOptimistic === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
                else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previousOptimistic;
            });

            const root = await mkdtemp(join(tmpdir(), "plurnk-notifications-matrix-"));
            const releaseFile = join(root, "release-stream");
            const db = await openMigrated();
            const http = await bindListener();
            const questionArgs = JSON.stringify({
                message: "Proceed with matrix?",
                requestedSchema: {
                    type: "object",
                    properties: { go: { type: "boolean" } },
                },
            });
            const provider = new Mock({
                contextWindow: viableWindow() * 4,
                responses: [
                    makeMockResponse(
                        `await plurnk.sh(${JSON.stringify({ command: `while [ ! -f "${releaseFile}" ]; do sleep 0.02; done && echo matrix-stream-ok` })});\n\nawait plurnk.question(${questionArgs});\n\nawait plurnk.wait({"text":"Await interaction."});`,
                    ),
                    makeMockResponse('await plurnk.wait({"text":"Await shell stream."});'),
                    makeMockResponse('await plurnk.done({"text":"Matrix loop completed."});'),
                ],
            });
            const daemon = new Daemon({ db, provider, http });
            t.after(async () => {
                await daemon.stop();
                await http.close();
                await db.close();
                await rm(root, { recursive: true, force: true });
            });

            const runtimeMethods = new Set<string>();
            const offRuntime = daemon.subscribeToRuntimeStream((_workspaceId, method) => {
                runtimeMethods.add(method);
            });
            t.after(offRuntime);

            await daemon.start();
            const { port } = http.httpAddress();
            const allStream = await openSse(t, port);
            await waitFor(() => allStream.snapshots, (items) => items.length === 1);
            assert.equal(allStream.snapshots[0].reason, "initial");

            // 1. workspace/created + 2. workspace/renamed
            const { workspaceId } = await daemon.createWorkspace({ name: "matrix-ws", projectRoot: root });
            const { workspaceId: otherWorkspaceId } = await daemon.createWorkspace({ name: "matrix-other" });
            await daemon.renameWorkspace(workspaceId, "matrix-ws-renamed");

            const wsStream = await openSse(t, port, `/${workspaceId}`);
            await waitFor(() => wsStream.snapshots, (items) => items.length === 1);
            assert.deepEqual(
                wsStream.snapshots[0].workspaces.map((w) => w.id),
                [workspaceId],
                "workspace-scoped notifications/snapshot includes only the target workspace even before any session exists",
            );

            // Cold workspace activation does NOT emit functionality/changed; mutations do.
            await daemon.activateWorkspace({ workspaceId });
            assert.equal(
                allStream.notifications.some((n) => n.event === "functionality/changed"),
                false,
                "cold workspace residency activation does not emit functionality/changed",
            );

            // 3. config/changed (workspace-scoped) & functionality/changed (workspace-scoped)
            await daemon.invokeModuleAction(
                "workspace.config.set",
                { key: "PLURNK_PROVIDERS_EFFORT", value: "adaptive" },
                { scope: "workspace", workspaceId },
            );
            await daemon.invokeModuleAction(
                "workspace.env.add",
                { alias: "MATRIX_WS_KEY", value: "alpha" },
                { scope: "workspace", workspaceId },
            );

            // 4. session/created (with persona) + child + ephemeral
            const { sessionId: mainSessionId } = await daemon.createSession({
                workspaceId,
                name: "main",
                persona: "reviewer",
            });
            const { sessionId: childSessionId } = await daemon.createSession({
                workspaceId,
                name: "child",
                parentSessionId: mainSessionId,
            });
            const { sessionId: ephemeralSessionId } = await daemon.createSession({
                workspaceId,
                name: "ephemeral",
            });
            await daemon.createSession({ workspaceId: otherWorkspaceId, name: "other-main" });

            const mainSessionStream = await openSse(t, port, `/${workspaceId}/main`);
            const childSessionStream = await openSse(t, port, `/${workspaceId}/child`);
            await waitFor(() => mainSessionStream.snapshots, (items) => items.length === 1);
            await waitFor(() => childSessionStream.snapshots, (items) => items.length === 1);
            assert.deepEqual(
                mainSessionStream.snapshots[0].sessions.map((s) => s.id),
                [mainSessionId],
                "session-scoped notifications/snapshot includes only the addressed session",
            );
            assert.equal(childSessionStream.snapshots[0].sessions[0]?.parentName, "main");
            assert.equal(childSessionStream.snapshots[0].sessions[0]?.parentOrigin, "model");

            // functionality/changed (session-scoped)
            await daemon.invokeModuleAction(
                "session.env.add",
                { alias: "MATRIX_SESS_KEY", value: "beta" },
                { scope: "session", workspaceId, sessionId: mainSessionId },
            );

            // 5. session/titled
            await daemon.setSessionTitle({ workspaceId, sessionId: mainSessionId, title: "Matrix Main" });

            // 6. session/policy (via setSessionPersona clearing and restoring persona)
            await daemon.setSessionPersona({ workspaceId, sessionId: mainSessionId, persona: null });
            await daemon.setSessionPersona({ workspaceId, sessionId: mainSessionId, persona: "reviewer" });

            // 7-15. loop/started (with opening), loop/parked, loop/proposal, loop/interaction,
            // loop/gate-settled (proposal + interaction), session/replied, stream/concluded, loop/terminated
            await ownSession(db, workspaceId, mainSessionId);
            const { loopId } = await daemon.runLoop({
                workspaceId,
                sessionId: mainSessionId,
                prompt: "Run the notification matrix.",
            });

            await waitFor(
                () => allStream.notifications.filter((n) => n.event === "loop/proposal"),
                (items) => items.length === 1,
                { timeoutMs: 10_000 },
            );

            // Mid-flight Watch homomorphism check while a review proposal gate is open!
            {
                let midState = createWatchState();
                for (const frame of allStream.frames) {
                    midState = reduceWatchNotification(midState, frame.envelope).state;
                }
                const watchProjected = projectWatchOverview(midState, {
                    limit: NotificationsEndpoint.sessionsLimit(),
                });
                const dbOverview = await daemon.readSessionOverview({
                    limit: NotificationsEndpoint.sessionsLimit(),
                    excerptChars: NotificationsEndpoint.excerptChars(),
                });
                assert.deepEqual(
                    watchProjected,
                    dbOverview,
                    "Watch store (Snapshot ⊕ Deltas) matches SQLite readSessionOverview while proposal gate is pending",
                );
            }

            const proposalEvent = allStream.notifications.find(
                (n): n is Extract<DaemonNotification, { event: "loop/proposal" }> => n.event === "loop/proposal",
            )!;
            await daemon.resolveProposal(
                proposalEvent.data.logEntryId,
                { decision: "accept" },
                { workspaceId, address: TEST_OWNER },
            );

            await waitFor(
                () => allStream.notifications.filter((n) => n.event === "loop/interaction"),
                (items) => items.length === 1,
                { timeoutMs: 10_000 },
            );
            await waitFor(
                () => allStream.notifications.filter((n) => n.event === "loop/parked"),
                (items) => items.length === 1,
                { timeoutMs: 10_000 },
            );

            // Mid-flight Watch homomorphism check while parked on an open client interaction!
            {
                let midState = createWatchState();
                for (const frame of allStream.frames) {
                    midState = reduceWatchNotification(midState, frame.envelope).state;
                }
                const watchProjected = projectWatchOverview(midState, {
                    limit: NotificationsEndpoint.sessionsLimit(),
                });
                const dbOverview = await daemon.readSessionOverview({
                    limit: NotificationsEndpoint.sessionsLimit(),
                    excerptChars: NotificationsEndpoint.excerptChars(),
                });
                assert.deepEqual(
                    watchProjected,
                    dbOverview,
                    "Watch store (Snapshot ⊕ Deltas) matches SQLite readSessionOverview while interaction gate is pending",
                );
            }

            const interactionEvent = allStream.notifications.find(
                (n): n is Extract<DaemonNotification, { event: "loop/interaction" }> =>
                    n.event === "loop/interaction",
            )!;
            await daemon.resolveClientInteraction(
                interactionEvent.data.interactionId,
                { action: "accept", content: { go: true } },
                { workspaceId, address: TEST_OWNER },
            );
            await waitFor(
                () => allStream.notifications.filter((n) => n.event === "loop/parked"),
                (items) => items.length === 2,
                { timeoutMs: 10_000 },
            );
            await writeFile(releaseFile, "ok");
            await waitFor(
                () =>
                    allStream.notifications.filter(
                        (n): n is Extract<DaemonNotification, { event: "stream/concluded" }> =>
                            n.event === "stream/concluded" && n.data.target.startsWith("exec:///sh/"),
                    ),
                (items) => items.length === 1,
                { timeoutMs: 10_000 },
            );

            await waitFor(
                () =>
                    allStream.notifications.filter(
                        (n) => n.event === "loop/terminated" && n.sessionId === mainSessionId,
                    ),
                (items) => items.length === 1,
                { timeoutMs: 15_000 },
            );

            const repliedEvent = allStream.notifications.find(
                (n): n is Extract<DaemonNotification, { event: "session/replied" }> =>
                    n.event === "session/replied" && n.sessionId === mainSessionId,
            );
            assert.ok(repliedEvent !== undefined, "done() reply emits compact session/replied on Watch bus");
            assert.equal(repliedEvent.data.reply.excerpt, "Matrix loop completed.");
            assert.equal(repliedEvent.data.reply.completion, 200);

            const startedEvent = allStream.notifications.find(
                (n): n is Extract<DaemonNotification, { event: "loop/started" }> =>
                    n.event === "loop/started" && n.sessionId === mainSessionId,
            );
            assert.equal(startedEvent?.data.opening, "Run the notification matrix.");

            // 16. notice/event (user-facing notice passes; internal telemetry goes only to runtime stream)
            daemon.notifyNotice(workspaceId, {
                sessionId: mainSessionId,
                loopId,
                notice: {
                    source: "exec:sqlite",
                    kind: "query_progress",
                    level: "info",
                    completed: 1,
                    total: 2,
                    percent: 50,
                },
            });
            daemon.notifyNotice(workspaceId, {
                sessionId: mainSessionId,
                loopId,
                notice: {
                    source: "provider:local",
                    kind: "output_unaccounted",
                    level: "warn",
                    message: "User-facing warning notice.",
                },
            });

            // 17. session/archived (subtree includes childSessionId) + unarchive
            await daemon.setSessionArchived({ workspaceId, sessionId: mainSessionId, archived: true });
            await daemon.setSessionArchived({ workspaceId, sessionId: mainSessionId, archived: false });

            // Re-hydrate after unarchive, delete ephemeralSessionId, and archive workspaceId
            await daemon.deleteSession({ workspaceId, sessionId: ephemeralSessionId });
            await daemon.setWorkspaceArchived({ workspaceId, archived: true });

            await waitFor(
                () => allStream.notifications.filter((n) => n.event === "workspace/archived"),
                (items) => items.length === 1,
                { timeoutMs: 5_000 },
            );

            // Final end-to-end Watch homomorphism check after subtree/workspace archive & session delete!
            {
                let endState = createWatchState();
                for (const frame of allStream.frames) {
                    endState = reduceWatchNotification(endState, frame.envelope).state;
                }
                const watchProjected = projectWatchOverview(endState, {
                    limit: NotificationsEndpoint.sessionsLimit(),
                });
                const dbOverview = await daemon.readSessionOverview({
                    limit: NotificationsEndpoint.sessionsLimit(),
                    excerptChars: NotificationsEndpoint.excerptChars(),
                });
                assert.deepEqual(
                    watchProjected,
                    dbOverview,
                    "Watch store (Snapshot ⊕ Deltas) matches SQLite readSessionOverview after full lifecycle matrix",
                );
            }

            // Every single one of the 19 discrete events was emitted and validated on SSE.
            const observedSet = new Set(allStream.notifications.map((n) => n.event));
            assert.deepEqual(
                [...observedSet].toSorted(),
                [...DAEMON_NOTIFICATION_EVENTS].toSorted(),
                "all 19 discrete notification events are witnessed on GET /notifications",
            );

            // Every SSE frame carries `<epoch>:<id>` matching daemon.notificationEpoch.
            for (const frame of allStream.frames) {
                assert.match(frame.id ?? "", new RegExp(`^${daemon.notificationEpoch}:\\d+$`, "u"));
            }

            // Internal journal (`log/entry`), telemetry, and sub-turn streaming stayed on subscribeToRuntimeStream only.
            for (const runtimeEvent of APPLICATION_RUNTIME_STREAM_EVENTS) {
                assert.equal(
                    allStream.frames.some((f) => f.event === runtimeEvent),
                    false,
                    `${runtimeEvent} never leaks onto GET /notifications`,
                );
            }
            assert.ok(runtimeMethods.has("log/entry"));
            assert.ok(runtimeMethods.has("workspace/preparation"));
            assert.ok(runtimeMethods.has("loop/packet"));
            assert.ok(runtimeMethods.has("stream/event"));
            assert.ok(runtimeMethods.has("runtime/telemetry"));
            assert.equal(
                allStream.notifications.some(
                    (n) => n.event === "notice/event" && n.data.notice.kind === "query_progress",
                ),
                false,
                "internal progress telemetry never appears as public notice/event",
            );

            // Persona facts carried on session/created and session/policy.
            const mainCreated = allStream.notifications.find(
                (n): n is Extract<DaemonNotification, { event: "session/created" }> =>
                    n.event === "session/created" && n.sessionId === mainSessionId,
            );
            assert.equal(mainCreated?.data.persona, "reviewer");
            const policyPersonas = allStream.notifications
                .filter(
                    (n): n is Extract<DaemonNotification, { event: "session/policy" }> =>
                        n.event === "session/policy" && n.sessionId === mainSessionId && "persona" in n.data,
                )
                .map((n) => n.data.persona);
            assert.ok(policyPersonas.includes(null) && policyPersonas.includes("reviewer"));

            // Both proposal and interaction gates settled with 1:1 loop/gate-settled payloads.
            const settledKinds = allStream.notifications
                .filter(
                    (n): n is Extract<DaemonNotification, { event: "loop/gate-settled" }> =>
                        n.event === "loop/gate-settled" && n.sessionId === mainSessionId,
                )
                .map((n) => n.data.kind);
            assert.deepEqual(settledKinds, ["proposal", "interaction"]);

            // Workspace stream received only `workspaceId` events (never `otherWorkspaceId`).
            assert.ok(wsStream.notifications.length > 0);
            assert.ok(wsStream.notifications.every((n) => n.workspaceId === workspaceId));
            assert.equal(wsStream.frames[0]?.envelope.workspaceId, workspaceId);

            // Session stream received session-scoped events (including session-scoped functionality/changed,
            // titled, policy, proposal, interaction, gate-settled, session/replied, stream/concluded, notice/event,
            // terminated, archived) and never workspace-only functionality/changed or other sessions.
            assert.equal(mainSessionStream.frames[0]?.envelope.workspaceId, workspaceId);
            assert.equal(mainSessionStream.frames[0]?.envelope.sessionId, mainSessionId);
            assert.ok(
                mainSessionStream.notifications.some(
                    (n) => n.event === "functionality/changed" && n.sessionId === mainSessionId,
                ),
            );
            assert.ok(
                mainSessionStream.notifications.some(
                    (n) => n.event === "session/replied" && n.sessionId === mainSessionId,
                ),
            );
            assert.equal(
                mainSessionStream.notifications.some(
                    (n) => n.event === "functionality/changed" && n.sessionId === null,
                ),
                false,
                "workspace-scoped functionality/changed has sessionId=null and does not leak into a session stream",
            );
            assert.ok(
                childSessionStream.notifications.some(
                    (n) => n.event === "session/archived" && n.data.sessionIds.includes(childSessionId),
                ),
                "subtree session/archived reaches descendant session streams",
            );
            assert.ok(
                mainSessionStream.notifications.some(
                    (n) => n.event === "loop/started" && n.sessionId === mainSessionId,
                ),
                "loop/started reaches session stream",
            );
            assert.ok(
                mainSessionStream.notifications.some(
                    (n) => n.event === "loop/parked" && n.sessionId === mainSessionId && n.data.status === 202,
                ),
                "loop/parked reaches session stream",
            );
            const streamConcluded = allStream.notifications.find(
                (n): n is Extract<DaemonNotification, { event: "stream/concluded" }> =>
                    n.event === "stream/concluded" && n.data.target.startsWith("exec:///sh/"),
            );
            assert.equal(streamConcluded?.data.result.status, 200);
            assert.equal(streamConcluded?.data.loopSeq, 1);
            assert.equal(streamConcluded?.data.turnSeq, 2);
        },
    );

    test(
        "{§notifications} {§http-host} Last-Event-ID replays missed filtered events in-window, self-heals via notifications/snapshot in Watch mode, and emits notifications/resync under ?since=now",
        { timeout: 20_000 },
        async (t) => {
            const priorBuffer = process.env.PLURNK_SERVICE_NOTIFICATIONS_BUFFER;
            process.env.PLURNK_SERVICE_NOTIFICATIONS_BUFFER = "4";
            t.after(() => {
                if (priorBuffer === undefined) delete process.env.PLURNK_SERVICE_NOTIFICATIONS_BUFFER;
                else process.env.PLURNK_SERVICE_NOTIFICATIONS_BUFFER = priorBuffer;
            });

            const db = await openMigrated();
            const http = await bindListener();
            const daemon = new Daemon({ db, provider: null, http });
            t.after(async () => {
                await daemon.stop();
                await http.close();
                await db.close();
            });
            await daemon.start();
            const { port } = http.httpAddress();

            // ?since=now skips the initial snapshot and tails only new discrete transitions.
            const tailInitial = await openSse(t, port, "?since=now");
            assert.equal(tailInitial.snapshots.length, 0);
            const { workspaceId: wsA } = await daemon.createWorkspace({ name: "replay-a" });
            await waitFor(() => tailInitial.frames, (items) => items.length === 1);
            const cursorAfterWsA = tailInitial.frames[0].id!;
            await tailInitial.close();

            // Emit 3 more events within the 4-event buffer window:
            // #2: workspace/created (wsB)
            // #3: session/created (wsA, s1)
            // #4: session/titled (wsA, s1)
            const { workspaceId: wsB } = await daemon.createWorkspace({ name: "replay-b" });
            assert.ok(wsB > 0);
            const { sessionId: s1 } = await daemon.createSession({ workspaceId: wsA, name: "alpha" });
            await daemon.setSessionTitle({ workspaceId: wsA, sessionId: s1, title: "Alpha Title" });

            // Scoped Last-Event-ID replay on /notifications/<wsA>/alpha returns ONLY #3 and #4 with zero snapshot!
            const resumedScoped = await openSse(t, port, `/${wsA}/alpha`, {
                "last-event-id": cursorAfterWsA,
            });
            await waitFor(() => resumedScoped.notifications, (items) => items.length === 2);
            assert.equal(resumedScoped.snapshots.length, 0);
            assert.equal(resumedScoped.resyncs.length, 0);
            assert.deepEqual(
                resumedScoped.notifications.map((n) => n.event),
                ["session/created", "session/titled"],
            );
            await resumedScoped.close();

            // Emit 2 more events (#5, #6) so buffer of size 4 retains only [#3, #4, #5, #6], evicting #2!
            await daemon.renameWorkspace(wsA, "replay-a-v2");
            await daemon.renameWorkspace(wsA, "replay-a-v3");

            // Default Watch reconnect with evicted cursor self-heals inline with notifications/snapshot(evicted)!
            const watchEvicted = await openSse(t, port, "", { "last-event-id": cursorAfterWsA });
            await waitFor(() => watchEvicted.snapshots, (items) => items.length === 1);
            assert.equal(watchEvicted.snapshots[0].reason, "evicted");
            assert.equal(watchEvicted.snapshots[0].epoch, daemon.notificationEpoch);
            assert.ok(watchEvicted.snapshots[0].latestId >= 6);
            assert.equal(
                watchEvicted.snapshots[0].workspaces.find((w) => w.id === wsA)?.name,
                "replay-a-v3",
            );
            assert.equal(
                watchEvicted.snapshots[0].sessions.find((s) => s.id === s1)?.title,
                "Alpha Title",
            );
            await watchEvicted.close();

            // Default Watch reconnect with stale boot epoch -> notifications/snapshot(restarted).
            const watchRestarted = await openSse(t, port, "", { "last-event-id": "deadbeefcaf0:2" });
            await waitFor(() => watchRestarted.snapshots, (items) => items.length === 1);
            assert.equal(watchRestarted.snapshots[0].reason, "restarted");
            await watchRestarted.close();

            // Default Watch reconnect with malformed cursor -> notifications/snapshot(malformed).
            const watchMalformed = await openSse(t, port, "", { "last-event-id": "not-a-valid-cursor" });
            await waitFor(() => watchMalformed.snapshots, (items) => items.length === 1);
            assert.equal(watchMalformed.snapshots[0].reason, "malformed");
            await watchMalformed.close();

            // Tail-only (?since=now) reconnects emit notifications/resync(evicted | restarted | malformed).
            const tailEvicted = await openSse(t, port, "?since=now", { "last-event-id": cursorAfterWsA });
            await waitFor(() => tailEvicted.resyncs, (items) => items.length === 1);
            assert.equal(tailEvicted.resyncs[0].reason, "evicted");
            assert.equal(tailEvicted.resyncs[0].epoch, daemon.notificationEpoch);
            assert.ok(tailEvicted.resyncs[0].latestId >= 6);
            await tailEvicted.close();

            const tailRestarted = await openSse(t, port, "?since=now", { "last-event-id": "deadbeefcaf0:2" });
            await waitFor(() => tailRestarted.resyncs, (items) => items.length === 1);
            assert.equal(tailRestarted.resyncs[0].reason, "restarted");
            await tailRestarted.close();

            const tailMalformed = await openSse(t, port, "?since=now", { "last-event-id": "not-a-valid-cursor" });
            await waitFor(() => tailMalformed.resyncs, (items) => items.length === 1);
            assert.equal(tailMalformed.resyncs[0].reason, "malformed");
            await tailMalformed.close();
        },
    );
});
