import Plurnk from "../schemes/Plurnk.ts";
import Log from "../schemes/Log.ts";
import Exec from "../schemes/Exec.ts";
import Known from "../schemes/Known.ts";
import Unknown from "../schemes/Unknown.ts";
import Skill from "../schemes/Skill.ts";
import File from "../schemes/File.ts";
import type { LoopFlags, SchemeManifest } from "./scheme-types.ts";

type SchemeHandler = object;

export default class SchemeRegistry {
    #handlers = new Map<string, SchemeHandler>();

    constructor() {
        this.register("plurnk",  new Plurnk());
        this.register("log",     new Log());
        this.register("exec",    new Exec());
        this.register("known",   new Known());
        this.register("unknown", new Unknown());
        this.register("skill",   new Skill());
        this.register("file",    new File());
    }

    register(name: string, handler: SchemeHandler): void {
        if (this.#handlers.has(name)) throw new Error(`scheme '${name}' is already registered`);
        this.#handlers.set(name, handler);
    }

    get(name: string): SchemeHandler | undefined { return this.#handlers.get(name); }

    has(name: string): boolean { return this.#handlers.has(name); }

    list(): string[] { return [...this.#handlers.keys()].toSorted(); }

    // Active set under the given loop flags. SCHEMES.md §16 / SPEC §0.5.
    // Schemes opt into flag affinity via `manifest.flags`; absence = always active.
    resolveForLoop(flags: LoopFlags): Set<string> {
        const active = new Set<string>();
        for (const [name, handler] of this.#handlers.entries()) {
            const affinity = (handler.constructor as { manifest?: SchemeManifest }).manifest?.flags;
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
