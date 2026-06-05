import { isAbsolute } from "node:path";
import type MethodRegistry from "../MethodRegistry.ts";
import Envelope from "../envelope.ts";

export default class SessionSetRootMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("session.set_root", {
            handler: async (params, ctx) => {
                if (ctx.session === null) {
                    throw new Error("session.set_root requires an attached session");
                }
                const p = (params ?? {}) as { projectRoot?: string | null };
                const projectRoot = p.projectRoot ?? null;
                if (projectRoot !== null) {
                    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
                        throw new Error("session.set_root: projectRoot must be a non-empty string or null");
                    }
                    if (!isAbsolute(projectRoot)) {
                        throw new Error("session.set_root: projectRoot must be an absolute path");
                    }
                }
                const updated = await Envelope.updateSessionProjectRoot(ctx.db, ctx.session.sessionId, projectRoot);
                // Mutate the attached envelope so subsequent handler invocations on
                // this connection observe the new value. ctx.session is the same
                // object reference held in ClientConnection.#session.
                ctx.session.projectRoot = updated;
                return { id: ctx.session.sessionId, projectRoot: updated };
            },
            description: "Update the workspace pointer (projectRoot) on the currently-attached session. Pass null to revert to headless mode.",
            params: {
                projectRoot: "string|null — absolute path to the client's workspace; null = headless",
            },
            requiresInit: true,
        });
    }
}
