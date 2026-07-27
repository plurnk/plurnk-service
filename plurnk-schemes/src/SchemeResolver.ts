// Active-scheme resolution under a given loop's flags. Schemes opt into
// flag affinity via `manifest.flags`; absence = always active.

import Manifest from "./Manifest.ts";
import type { LoopFlags } from "./types.ts";

export default class SchemeResolver {
    // Given a map of scheme name → handler instance and the active loop's flags,
    // return the set of scheme names eligible to dispatch. Schemes without
    // `manifest.flags` are always active; `excludedInAsk` filters under
    // `mode === "ask"`, and `requiresWeb` / `requiresInteraction` / `proposes`
    // filter under the corresponding `no*` flag.
    static forLoop(handlers: ReadonlyMap<string, object>, flags: LoopFlags): Set<string> {
        const active = new Set<string>();
        for (const [name, handler] of handlers.entries()) {
            const affinity = Manifest.of(handler, name).flags;
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
