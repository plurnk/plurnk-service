import Plurnk from "../schemes/Plurnk.ts";
import Log from "../schemes/Log.ts";
import Exec from "../schemes/Exec.ts";
import Known from "../schemes/Known.ts";
import Unknown from "../schemes/Unknown.ts";
import Skill from "../schemes/Skill.ts";
import File from "../schemes/File.ts";
import Run from "../schemes/Run.ts";
import ResolveForLoop from "./resolveForLoop.ts";
import PluginTrust from "./plugin-trust.ts";
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
        this.register("run",     new Run());
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

    // Scheme-education catalogue, injected into the model's packet at packet-time
    // (grammar 0.49+ teaches grammar/dialects only, not the scheme set — grammar#239).
    // Each registered handler contributes its `static teach` (the semantics/when-to-use
    // blurb) plus a one-line summary derived from `static manifest` (channels, default
    // channel, who may write). Handlers with no `teach` are skipped. Insertion order.
    teach(): string {
        const sections: string[] = ["## Schemes"];
        for (const [name, handler] of this.#handlers) {
            const cls = handler.constructor as {
                teach?: string;
                manifest?: { defaultChannel?: string; channels?: Record<string, string>; writableBy?: ReadonlyArray<string>; example?: string; documentation?: string };
            };
            if (typeof cls.teach !== "string" || cls.teach.length === 0) continue;
            const manifest = cls.manifest ?? {};
            const channelNames = Object.keys(manifest.channels ?? {});
            const channels = channelNames.length > 0 ? channelNames.join(", ") : "none";
            const defaultChannel = manifest.defaultChannel !== undefined && manifest.defaultChannel.length > 0 ? manifest.defaultChannel : "none";
            const writableBy = (manifest.writableBy ?? []).join(", ") || "none";
            // #note12 — the daughter's usage example (inline) + a doc-link to its fuller
            // documentation when the manifest ships it (optional; in-tree schemes have none
            // yet, so the link lights up the day plurnk-schemes adds `documentation`, exactly
            // as execs do today). The doc's token cost rides the manifest entry it materializes.
            const example = typeof manifest.example === "string" && manifest.example.length > 0 ? `\nExample: ${manifest.example}` : "";
            const docLink = typeof manifest.documentation === "string" && manifest.documentation.length > 0 ? `\nDocs: plurnk:///docs/${name}` : "";
            sections.push(`### \`${name}:///\`\n${cls.teach}\nChannels: ${channels} (default: ${defaultChannel}). Writable by: ${writableBy}.${example}${docLink}`);
        }
        return sections.join("\n\n");
    }

    // #note12 — schemes that ship a `documentation` string, for materialization at
    // plurnk:///docs/<name>. Optional + currently none in-tree; future-proofs the link.
    docs(): Array<{ name: string; content: string }> {
        const out: Array<{ name: string; content: string }> = [];
        for (const [name, handler] of this.#handlers) {
            const doc = (handler.constructor as { manifest?: { documentation?: string } }).manifest?.documentation;
            if (typeof doc === "string" && doc.length > 0) out.push({ name, content: doc });
        }
        return out;
    }

    // Discover external scheme siblings — agnostic by plurnk.kind:"scheme" (never
    // by package name OR scope, #227) so a third party ships one under ANY name,
    // exactly like executors. Registered by declared plurnk.name; a sibling reaches
    // the substrate only through the DB-free SchemeCtx the engine wraps for
    // isExternal() schemes. A name collision with an in-tree scheme fail-hards in register.
    async discoverExternal(cwd: string = process.cwd()): Promise<void> {
        for (const dir of await SchemeRegistry.#packageDirs(join(cwd, "node_modules"))) {
            const raw = await readFile(join(dir, "package.json"), "utf8").catch(() => null);
            if (raw === null) continue;
            let pkg: { plurnk?: { kind?: string; name?: string }; name?: string };
            try { pkg = JSON.parse(raw); } catch { continue; }
            const plurnk = pkg.plurnk;
            if (plurnk?.kind !== "scheme" || typeof plurnk.name !== "string" || plurnk.name === "") continue;
            if (typeof pkg.name !== "string") continue;
            // #229 — trust gate: an untrusted third-party scheme is discovered but
            // NOT registered (skipped with a note, never crashed).
            if (!PluginTrust.isTrusted(pkg.name)) {
                console.warn(`scheme discovery: '${pkg.name}' is discovered but untrusted (PLURNK_PLUGINS_TRUSTED_ONLY); not registered`);
                continue;
            }
            // Idempotent + in-tree precedence: a name already registered (a
            // built-in, or a re-scan) is left as-is rather than fail-harding on
            // re-register. Discovery must be safe to call again.
            if (this.has(plurnk.name)) continue;
            const mod = await import(pkg.name) as { default: new () => SchemeHandler };
            this.register(plurnk.name, new mod.default());
            this.#external.add(plurnk.name);
        }
    }

    // Every installed package dir — unscoped (node_modules/pkg) AND each scoped
    // member (node_modules/@scope/pkg). The scope-agnostic walk (#227): discovery
    // keys on plurnk.kind, never the @plurnk scope, so any vendor can publish a sibling.
    static async #packageDirs(root: string): Promise<string[]> {
        const top = await readdir(root, { withFileTypes: true }).catch(() => null);
        if (top === null) return [];
        const dirs: string[] = [];
        for (const entry of top) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith("@")) {
                const scoped = await readdir(join(root, entry.name), { withFileTypes: true }).catch(() => null);
                for (const s of scoped ?? []) if (s.isDirectory()) dirs.push(join(root, entry.name, s.name));
            } else {
                dirs.push(join(root, entry.name));
            }
        }
        return dirs;
    }

    // Active set under the given loop flags (SPEC §engine-rails). Delegates to
    // the in-tree ResolveForLoop utility.
    resolveForLoop(flags: LoopFlags): Set<string> {
        return ResolveForLoop.resolveForLoop(this.#handlers, flags);
    }
}
