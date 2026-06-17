import type MethodRegistry from "../MethodRegistry.ts";
import GitMembership from "../../core/git-membership.ts";

// #243 — resolved per-file membership for client gutter signs (plurnk.nvim's Active/
// ReadOnly/Ignore made visible). The daemon owns git ls-files + the pick/hide/view
// overlay, so it resolves each project file's effect and the client reads it — zero
// glob-matching client-side (the service-logic duplication we avoid on principle).
// Session-scoped like the overlay itself; reads the attached session.
export default class SessionMembersMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("session.members", {
            handler: async (_params, ctx) => {
                if (ctx.session === null) throw new Error("session.members requires an attached session");
                return GitMembership.resolveMembershipEffects(ctx.db, ctx.session.sessionId, undefined);
            },
            description: "Resolve each project file's membership effect — for client gutter signs / colors, with zero glob-matching client-side (the daemon owns git + the overlay). → { members: [{ path, effect: 'member' | 'view' }], hidden: [path] }: members are (ls-files ∪ pick) − hide (effect `view` = read-only, refused at the File edit gate); hidden are project files a `hide` constraint excludes from the manifest. Re-read cheaply on membership change.",
            params: {},
            requiresInit: true,
        });
    }
}
