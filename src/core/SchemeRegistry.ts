import Plurnk from "../schemes/Plurnk.ts";
import Log from "../schemes/Log.ts";
import Exec from "../schemes/Exec.ts";
import Known from "../schemes/Known.ts";
import Unknown from "../schemes/Unknown.ts";
import Skill from "../schemes/Skill.ts";
import File from "../schemes/File.ts";
import ResolveForLoop from "./resolveForLoop.ts";
import type { LoopFlags } from "./types.ts";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

type SchemeHandler = object;

export default class SchemeRegistry {
    #handlers = new Map<string, SchemeHandler>();
    #external = new Set<string>();

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

    // True for schemes registered via discoverExternal — they receive the
    // DB-free SchemeCtx (caps), not the in-tree PlurnkSchemeContext.
    isExternal(name: string): boolean { return this.#external.has(name); }

    list(): string[] { return [...this.#handlers.keys()].toSorted(); }

    // Discover external @plurnk/plurnk-schemes-* siblings — agnostic by
    // plurnk.kind:"scheme" (never by package name) — and register each by its
    // declared plurnk.name. A sibling reaches the substrate only through the
    // DB-free SchemeCtx the engine wraps for isExternal() schemes. Mirrors the
    // execs scan; a name collision with an in-tree scheme fail-hards in register.
    async discoverExternal(cwd: string = process.cwd()): Promise<void> {
        const scope = join(cwd, "node_modules", "@plurnk");
        const entries = await readdir(scope, { withFileTypes: true }).catch(() => null);
        if (entries === null) return;
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const raw = await readFile(join(scope, entry.name, "package.json"), "utf8").catch(() => null);
            if (raw === null) continue;
            let pkg: { plurnk?: { kind?: string; name?: string }; name?: string };
            try { pkg = JSON.parse(raw); } catch { continue; }
            const plurnk = pkg.plurnk;
            if (plurnk?.kind !== "scheme" || typeof plurnk.name !== "string" || plurnk.name === "") continue;
            if (typeof pkg.name !== "string") continue;
            // Idempotent + in-tree precedence: a name already registered (a
            // built-in, or a re-scan of the same scope) is left as-is rather than
            // fail-harding on re-register. Discovery must be safe to call again.
            if (this.has(plurnk.name)) continue;
            const mod = await import(pkg.name) as { default: new () => SchemeHandler };
            this.register(plurnk.name, new mod.default());
            this.#external.add(plurnk.name);
        }
    }

    // Active set under the given loop flags (SPEC §0.5). Delegates to
    // the in-tree ResolveForLoop utility.
    resolveForLoop(flags: LoopFlags): Set<string> {
        return ResolveForLoop.resolveForLoop(this.#handlers, flags);
    }
}
