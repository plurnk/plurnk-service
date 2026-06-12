import { isAbsolute } from "node:path";
import type MethodRegistry from "../MethodRegistry.ts";
import Envelope from "../envelope.ts";

export default class SessionCreateMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("session.create", {
            handler: async (params, ctx) => {
                const p = params as { name?: string; projectRoot?: string | null; persona?: string | null };
                const projectRoot = p.projectRoot ?? null;
                if (projectRoot !== null) {
                    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
                        throw new Error("session.create: projectRoot must be a non-empty string or null");
                    }
                    if (!isAbsolute(projectRoot)) {
                        throw new Error("session.create: projectRoot must be an absolute path");
                    }
                }
                const persona = p.persona ?? null;
                if (persona !== null && typeof persona !== "string") {
                    throw new Error("session.create: persona must be a string or null");
                }
                const envelope = await Envelope.createClientEnvelope(ctx.db, { name: p.name, projectRoot, persona });
                ctx.attachSession(envelope);
                ctx.notify("all", "session/created", {
                    id: envelope.sessionId,
                    name: envelope.sessionName,
                    projectRoot: envelope.projectRoot,
                    persona: envelope.sessionPersona,
                });
                return {
                    id: envelope.sessionId, name: envelope.sessionName,
                    runId: envelope.runId, runName: envelope.runName,
                    projectRoot: envelope.projectRoot, persona: envelope.sessionPersona,
                };
            },
            description: "Create a new session and attach this connection to it. Optionally pin the session to a workspace via projectRoot, and/or set a session-level persona (text/markdown injected into packet.system.persona). Per-run and per-loop overrides may further refine the persona.",
            params: {
                name: "string? — session name (auto-generated if omitted)",
                projectRoot: "string? — absolute path to the client's workspace; null/omitted = headless mode (no disk side-effects on file ops)",
                persona: "string? — session-level persona (text/markdown); cascades as: loops.persona > runs.persona > sessions.persona > PLURNK_PERSONA file",
            },
        });

        registry.registerNotification("session/created", {
            description: "A new session has been created. Broadcast to all connected clients.",
            params: {
                id: "number — session id",
                name: "string — session name",
                projectRoot: "string|null — workspace pointer for the session (null = headless)",
                persona: "string|null — session-level persona override (null = no override at this level)",
            },
        });
    }
}
