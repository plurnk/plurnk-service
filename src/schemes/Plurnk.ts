import type { SchemeManifest } from "../core/scheme-types.ts";

// PROVISIONAL: meta-scheme for protocol management. Surface not yet designed
// (scheme registration ops, runtime config). modelVisible=false — audit-style.

export default class Plurnk {
    static manifest: SchemeManifest = {
        name: "plurnk",
        channels: {},
        defaultChannel: "",
        category: "logging",
        scope: "agent",
        writableBy: ["system", "plugin"],
        volatile: false,
        modelVisible: false,
    };
}
