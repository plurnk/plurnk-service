import Plurnk from "../schemes/Plurnk.ts";
import Log from "../schemes/Log.ts";
import Exec from "../schemes/Exec.ts";
import Known from "../schemes/Known.ts";
import Unknown from "../schemes/Unknown.ts";
import Skill from "../schemes/Skill.ts";
import File from "../schemes/File.ts";
import Run from "../schemes/Run.ts";
import ResolveForLoop from "./resolveForLoop.ts";
import type { LoopFlags } from "./types.ts";
import { SchemeDiscovery, type SchemeHandler } from "@plurnk/plurnk-schemes";
import type { PacketSection } from "./packet-wire.ts";
import type { PacketSectionTransformer } from "./scheme-types.ts";

export default class SchemeRegistry {
    // Heterogeneous handler store — in-tree schemes take PlurnkSchemeContext, external
    // siblings the DB-free SchemeCtx of the imported SchemeHandler; the common supertype
    // is `object`. Dispatch (Engine.#run) borrows SchemeHandler's op-key set, not its ctx.
    #handlers = new Map<string, object>();
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

    register(name: string, handler: object): void {
        if (this.#handlers.has(name)) throw new Error(`scheme '${name}' is already registered`);
        this.#handlers.set(name, handler);
    }

    get(name: string): object | undefined { return this.#handlers.get(name); }

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
            const docLink = typeof manifest.documentation === "string" && manifest.documentation.length > 0 ? `\nDocs: plurnk://docs/${name}.md` : "";
            sections.push(`### \`${name}:///\`\n${cls.teach}\nChannels: ${channels} (default: ${defaultChannel}). Writable by: ${writableBy}.${example}${docLink}`);
        }
        return sections.join("\n\n");
    }

    // #note12 — schemes that ship a `documentation` string, for materialization at
    // plurnk:///docs/<name>.md. Optional + currently none in-tree; future-proofs the link.
    docs(): Array<{ name: string; content: string }> {
        const out: Array<{ name: string; content: string }> = [];
        for (const [name, handler] of this.#handlers) {
            const doc = (handler.constructor as { manifest?: { documentation?: string } }).manifest?.documentation;
            if (typeof doc === "string" && doc.length > 0) out.push({ name, content: doc });
        }
        return out;
    }

    // Plugin packet control (§packet-construction): pipe the engine's default
    // section list through every registered scheme that implements
    // transformSections, in registration order. A scheme returns whatever list it
    // wants — add, remove, reorder. The trusted in-process seam; the client wire
    // never touches the packet. In-tree + external handlers both, duck-typed.
    async transformSections(sections: PacketSection[]): Promise<PacketSection[]> {
        let current = sections;
        for (const handler of this.#handlers.values()) {
            const transform = (handler as Partial<PacketSectionTransformer>).transformSections;
            if (typeof transform === "function") current = await transform.call(handler, current);
        }
        return current;
    }

    // Discover external scheme siblings — delegated to the framework's SchemeDiscovery
    // (schemes 0.9+): the scope-agnostic node_modules scan for plurnk.kind:"scheme" +
    // plurnk.name AND the PLURNK_PLUGINS_TRUSTED_ONLY trust gate (untrusted → `skipped`,
    // never crashed) both live there now, single-sourced across the plugin families
    // (the "delegate upstream" rule — execs/mimetypes/providers already ship discover()).
    // The service keeps only consumer policy: in-tree precedence (a name a built-in owns
    // is left as-is) and importing + registering the trusted descriptors. A sibling reaches
    // the substrate only through the DB-free SchemeCtx the engine wraps for isExternal() schemes.
    async discoverExternal(cwd: string = process.cwd()): Promise<void> {
        const { schemes, skipped } = await SchemeDiscovery.discover({ cwd });
        for (const name of skipped) {
            console.warn(`scheme discovery: '${name}' is discovered but untrusted (PLURNK_PLUGINS_TRUSTED_ONLY); not registered`);
        }
        for (const { name, packageName } of schemes) {
            if (this.has(name)) continue; // in-tree precedence + idempotent re-scan
            const mod = await import(packageName) as { default: new () => SchemeHandler };
            this.register(name, new mod.default());
            this.#external.add(name);
        }
    }

    // Active set under the given loop flags (SPEC §engine-rails). Delegates to
    // the in-tree ResolveForLoop utility.
    resolveForLoop(flags: LoopFlags): Set<string> {
        return ResolveForLoop.resolveForLoop(this.#handlers, flags);
    }
}
