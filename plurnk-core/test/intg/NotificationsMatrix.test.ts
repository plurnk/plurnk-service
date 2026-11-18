import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe, type TestContext } from "node:test";
import {
    APPLICATION_RUNTIME_STREAM_EVENTS,
    DAEMON_NOTIFICATION_EVENTS,
    Validator,
    type DaemonNotification,
    type NotificationsResyncPayload,
} from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { ownSession, TEST_OWNER } from "./_approval.ts";
import { openMigrated } from "./_db.ts";
import { bindListener } from "./_http.ts";
import { makeMockResponse } from "./_mock.ts";
import { viableWindow } from "./_provider.ts";
import { waitFor } from "./_rpc.ts";

interface SseFrame {
    readonly id: string | null;
    readonly event: string;
    readonly data: unknown;
}

const openSse = async (
    t: TestContext,
    port: number,
    suffix = "",
    headers: Readonly<Record<string, string>> = {},
) => {
    const controller = new AbortController();
    t.after(() => controller.abort());
    const res = await fetch(`http://127.0.0.1:${port}/notifications${suffix}`, {
        headers: { accept: "text/event-stream", ...headers },
        signal: controller.signal,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");

    const frames: SseFrame[] = [];
    const notifications: DaemonNotification[] = [];
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
                    const parsed: unknown = JSON.parse(dataText);
                    frames.push({ id, event, data: parsed });
                    if (event === "notifications/resync") {
                        resyncs.push(parsed as NotificationsResyncPayload);
                    } else {
                        notifications.push(Validator.assertDaemonNotification(parsed));
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

    await firstFrame.promise;
    return {
        frames,
        notifications,
        resyncs,
        closed: closed.promise,
        close: async () => {
            controller.abort();
            await reader;
        },
    };
};

describe("Notifications matrix and replay", () => {
    test(
        "{§notifications} {§http-host} {§application-session-observation} all 16 discrete notification events validate against DaemonNotificationEnvelope, respect /notifications[/<workspace>[/<session>]] scoping, and exclude runtime stream telemetry",
        { timeout: 30_000 },
        async (t) => {
            const previousPersona = process.env.PLURNK_PERSONAS_reviewer;
            process.env.PLURNK_PERSONAS_reviewer = JSON.stringify({
                description: "Matrix reviewer persona",
                body: "Review code concisely.",
            });
            t.after(() => {
                if (previousPersona === undefined) delete process.env.PLURNK_PERSONAS_reviewer;
                else process.env.PLURNK_PERSONAS_reviewer = previousPersona;
            });

            const root = await mkdtemp(join(tmpdir(), "plurnk-notifications-matrix-"));
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
                        `await plurnk.sh({"command":"echo matrix-stream-ok"});\n\nawait plurnk.question(${questionArgs});\n\nawait plurnk.wait({"text":"Await stream and interaction."});`,
                    ),
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

            // 1. workspace/created + 2. workspace/renamed
            const { workspaceId } = await daemon.createWorkspace({ name: "matrix-ws", projectRoot: root });
            const { workspaceId: otherWorkspaceId } = await daemon.createWorkspace({ name: "matrix-other" });
            await daemon.renameWorkspace(workspaceId, "matrix-ws-renamed");

            const wsStream = await openSse(t, port, `/${workspaceId}`);

            // Cold workspace activation does NOT emit functionality/changed; mutations do.
            await daemon.activateWorkspace({ workspaceId });
            assert.equal(
                allStream.notifications.some((n) => n.event === "functionality/changed"),
                false,
                "cold workspace residency activation does not emit functionality/changed",
            );

            // 3. functionality/changed (workspace-scoped)
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

            // 7-13. loop/proposal, loop/interaction, loop/gate-settled (proposal + interaction),
            // log/entry, stream/concluded, loop/terminated
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
            const interactionEvent = allStream.notifications.find(
                (n): n is Extract<DaemonNotification, { event: "loop/interaction" }> =>
                    n.event === "loop/interaction",
            )!;
            await waitFor(
                () => allStream.notifications.filter((n) => n.event === "stream/concluded"),
                (items) => items.length === 1,
                { timeoutMs: 10_000 },
            );
            await daemon.resolveClientInteraction(
                interactionEvent.data.interactionId,
                { action: "accept", content: { go: true } },
                { workspaceId, address: TEST_OWNER },
            );

            await waitFor(
                () =>
                    allStream.notifications.filter(
                        (n) => n.event === "loop/terminated" && n.sessionId === mainSessionId,
                    ),
                (items) => items.length === 1,
                { timeoutMs: 15_000 },
            );

            // 14. notice/event (user-facing notice passes; internal telemetry goes only to runtime stream)
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

            // 15. session/archived (subtree includes childSessionId) + unarchive
            await daemon.setSessionArchived({ workspaceId, sessionId: mainSessionId, archived: true });
            await daemon.setSessionArchived({ workspaceId, sessionId: mainSessionId, archived: false });

            // 16. session/deleted + workspace/archived
            await daemon.deleteSession({ workspaceId, sessionId: ephemeralSessionId });
            await daemon.setWorkspaceArchived({ workspaceId, archived: true });

            await waitFor(
                () => allStream.notifications.filter((n) => n.event === "workspace/archived"),
                (items) => items.length === 1,
                { timeoutMs: 5_000 },
            );

            // Every single one of the 16 discrete events was emitted and validated on SSE.
            const observedSet = new Set(allStream.notifications.map((n) => n.event));
            assert.deepEqual(
                [...observedSet].toSorted(),
                [...DAEMON_NOTIFICATION_EVENTS].toSorted(),
                "all 16 discrete notification events are witnessed on GET /notifications",
            );

            // Every SSE frame carries `<epoch>:<id>` matching daemon.notificationEpoch.
            for (const frame of allStream.frames) {
                assert.match(frame.id ?? "", new RegExp(`^${daemon.notificationEpoch}:\\d+$`, "u"));
            }

            // Internal telemetry and sub-turn streaming stayed on subscribeToRuntimeStream only.
            for (const runtimeEvent of APPLICATION_RUNTIME_STREAM_EVENTS) {
                assert.equal(
                    allStream.frames.some((f) => f.event === runtimeEvent),
                    false,
                    `${runtimeEvent} never leaks onto GET /notifications`,
                );
            }
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

            // Session stream received session-scoped events (including session-scoped functionality/changed,
            // titled, policy, proposal, interaction, gate-settled, log/entry, stream/concluded, notice/event,
            // terminated, archived) and never workspace-only functionality/changed or other sessions.
            assert.ok(
                mainSessionStream.notifications.some(
                    (n) => n.event === "functionality/changed" && n.sessionId === mainSessionId,
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
        },
    );

    test(
        "{§notifications} {§http-host} Last-Event-ID replays missed filtered events in-window and emits notifications/resync on evicted, restarted, and malformed cursors",
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

            const initial = await openSse(t, port);
            const { workspaceId: wsA } = await daemon.createWorkspace({ name: "replay-a" });
            await waitFor(() => initial.frames, (items) => items.length === 1);
            const cursorAfterWsA = initial.frames[0].id!;
            await initial.close();

            // Emit 3 more events within the 4-event buffer window:
            // #2: workspace/created (wsB)
            // #3: session/created (wsA, s1)
            // #4: session/titled (wsA, s1)
            const { workspaceId: wsB } = await daemon.createWorkspace({ name: "replay-b" });
            assert.ok(wsB > 0);
            const { sessionId: s1 } = await daemon.createSession({ workspaceId: wsA, name: "alpha" });
            await daemon.setSessionTitle({ workspaceId: wsA, sessionId: s1, title: "Alpha Title" });

            // Scoped Last-Event-ID replay on /notifications/<wsA>/alpha returns ONLY #3 and #4!
            const resumedScoped = await openSse(t, port, `/${wsA}/alpha`, {
                "last-event-id": cursorAfterWsA,
            });
            await waitFor(() => resumedScoped.notifications, (items) => items.length === 2);
            assert.equal(resumedScoped.resyncs.length, 0);
            assert.deepEqual(
                resumedScoped.notifications.map((n) => n.event),
                ["session/created", "session/titled"],
            );
            await resumedScoped.close();

            // Emit 2 more events (#5, #6) so buffer of size 4 retains only [#3, #4, #5, #6], evicting #2!
            await daemon.renameWorkspace(wsA, "replay-a-v2");
            await daemon.renameWorkspace(wsA, "replay-a-v3");

            // Reconnecting with cursorAfterWsA (#1) now misses #2, so it receives notifications/resync(evicted).
            const evictedStream = await openSse(t, port, "", { "last-event-id": cursorAfterWsA });
            await waitFor(() => evictedStream.resyncs, (items) => items.length === 1);
            assert.equal(evictedStream.resyncs[0].reason, "evicted");
            assert.equal(evictedStream.resyncs[0].epoch, daemon.notificationEpoch);
            assert.ok(evictedStream.resyncs[0].latestId >= 6);
            await evictedStream.close();

            // Stale boot epoch -> notifications/resync(restarted).
            const restartedStream = await openSse(t, port, "", { "last-event-id": "deadbeefcaf0:2" });
            await waitFor(() => restartedStream.resyncs, (items) => items.length === 1);
            assert.equal(restartedStream.resyncs[0].reason, "restarted");
            assert.equal(restartedStream.resyncs[0].epoch, daemon.notificationEpoch);
            await restartedStream.close();

            // Malformed cursor -> notifications/resync(malformed).
            const malformedStream = await openSse(t, port, "", { "last-event-id": "not-a-valid-cursor" });
            await waitFor(() => malformedStream.resyncs, (items) => items.length === 1);
            assert.equal(malformedStream.resyncs[0].reason, "malformed");
            assert.equal(malformedStream.resyncs[0].epoch, daemon.notificationEpoch);
            await malformedStream.close();
        },
    );
});
