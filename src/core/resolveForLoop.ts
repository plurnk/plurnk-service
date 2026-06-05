// Active-scheme resolution under a given loop's flags. Schemes opt into
// flag affinity via `manifest.flags`; absence = always active.

import type { LoopFlags, SchemeManifest } from "./types.ts";

interface SchemeWithManifest {
    constructor: { manifest?: SchemeManifest };
}

export default class ResolveForLoop {
    /**
     * Given a map of scheme name → handler instance and the active loop's
     * flags, return the set of scheme names eligible to dispatch.
     *
     * - Schemes without `manifest.flags` are always active.
     * - `excludedInAsk` filters out under `mode === "ask"`.
     * - `requiresWeb` / `requiresInteraction` / `proposes` filter out under
     *   the corresponding `no*` flag.
     */
    static resolveForLoop(
        handlers: ReadonlyMap<string, object>,
        flags: LoopFlags,
    ): Set<string> {
        const active = new Set<string>();
        for (const [name, handler] of handlers.entries()) {
            const affinity = (handler as SchemeWithManifest).constructor.manifest?.flags;
            if (affinity === undefined) {
                active.add(name);
                continue;
            }
            if (flags.mode === "ask" && affinity.excludedInAsk) continue;
            if (flags.noWeb && affinity.requiresWeb) continue;
            if (flags.noInteraction && affinity.requiresInteraction) continue;
            if (flags.noProposals && affinity.proposes) continue;
            active.add(name);
        }
        return active;
    }
}
