// SPEC {§exec-env-scoped} {§operator-config-env-defaults} — the configuration catalog the
// `env` family's `discover` projects: every knob the installed packages declare, owner-labelled,
// with each declaration's comment as its documentation.
//
// One artifact, three doors. This is the same text `plurnk-service config defaults` prints and
// the same text a package ships; nothing is re-encoded into JSON fields for the model. That is
// the point of the unified cascade — the model reads what the operator reads.
//
// What it is NOT: a permissions list. The model may set any name the invariant does not refuse,
// including names nothing declares. The catalog answers a different question — which keys have a
// CONSUMER. `FOO=bar` is valid and nothing reads it; `PAGER=less` is valid and something does.
import EnvDefaults, { type EnvDefaultsFile } from "./env-defaults.ts";

export interface EnvCatalogQuery {
    // Substring match over a declaration's name and its comment, case-insensitive.
    readonly query?: string;
    // One owning package, exactly as the catalog labels it.
    readonly source?: string;
}

// One declaration with the comment block immediately above it. A file's leading prose (the
// header comment that belongs to no key) is kept with the first declaration it precedes, so a
// filtered projection never strands it.
interface Declaration {
    readonly name: string;
    readonly text: string;
}

export default class EnvCatalog {
    // Declarations in file order, each carrying the comment lines that introduce it. A commented
    // declaration (`# PLURNK_EXECS_ONLY=sh,jq`) is an optional knob, not prose, so it is a
    // declaration in its own right and stays findable by name.
    static declarations(text: string): readonly Declaration[] {
        const out: Declaration[] = [];
        let pending: string[] = [];
        for (const line of text.split("\n")) {
            const bare = line.trim();
            if (bare.length === 0) { pending.push(line); continue; }
            const assignment = /^#?\s*([A-Za-z_][A-Za-z0-9_]*)=/u.exec(bare);
            // A comment that is not an assignment introduces whatever comes next.
            if (assignment === null) { pending.push(line); continue; }
            out.push({ name: assignment[1]!, text: [...pending, line].join("\n") });
            pending = [];
        }
        return out;
    }

    // The name, or the comment that documents it — a Worker looks for a variable by what it is
    // for ("search") before it knows what it is called. Never the value: a value match would
    // surface a value the model did not ask to see — the catalog carries shipped defaults rather
    // than operator secrets, but the model's own context hygiene is reason enough not to hand it
    // bytes it was not looking for.
    // The structured projection {§functionality-model-projection} requires: one candidate per
    // declaration, directly addable. The comment becomes the candidate's summary and the owning
    // package its provenance, so nothing is invented and the documentation is not lost — it moves
    // from a comment line into the field that exists for it.
    static candidates(files: readonly EnvDefaultsFile[], query: EnvCatalogQuery = {}): readonly {
        alias: string; summary?: string; definition: { value: string };
        provenance: { kind: string; source: string; reference: string };
    }[] {
        const { query: term, source } = query;
        const selected = source === undefined ? files : files.filter((file) => file.owner === source);
        const out = [];
        for (const file of selected) {
            for (const declaration of EnvCatalog.declarations(file.text)) {
                if (term !== undefined && !EnvCatalog.#matches(declaration, term)) continue;
                const lines = declaration.text.split("\n");
                const assignment = lines[lines.length - 1]!.trim().replace(/^#+\s*/u, "");
                const summary = lines.slice(0, -1)
                    .map((line) => line.trim().replace(/^#+\s*/u, ""))
                    // A section header ("── Defaults ──────") introduces a region of the file, not
                    // this key. It begins with a run of rule characters, which prose never does.
                    .filter((line) => line.length > 0 && !/^[─═—–=_~*-]{2,}/u.test(line))
                    .join(" ");
                out.push({
                    alias: declaration.name,
                    ...(summary.length > 0 ? { summary } : {}),
                    definition: { value: assignment.slice(assignment.indexOf("=") + 1) },
                    provenance: { kind: "declaration", source: file.owner, reference: ".env.defaults" },
                });
            }
        }
        return out;
    }

    static #matches(declaration: Declaration, query: string): boolean {
        const term = query.toLowerCase();
        if (declaration.name.toLowerCase().includes(term)) return true;
        const lines = declaration.text.split("\n");
        return lines.slice(0, -1).some((line) => line.toLowerCase().includes(term));
    }

    // The projection. An empty query is the whole catalog: there is no remote index to search
    // and nothing to page, so dumping it is honest — the preview bound ({§body-projection}) is what
    // keeps it from flooding, and the model scopes or patterns into the rest with native tools.
    static project(files: readonly EnvDefaultsFile[], query: EnvCatalogQuery = {}): string {
        const { query: term, source } = query;
        const selected = source === undefined ? files : files.filter((file) => file.owner === source);
        if (term === undefined) return EnvDefaults.renderCatalog(selected);
        const filtered = selected
            .map((file) => ({
                ...file,
                text: EnvCatalog.declarations(file.text)
                    .filter((declaration) => EnvCatalog.#matches(declaration, term))
                    .map(({ text }) => text)
                    .join("\n"),
            }))
            .filter((file) => file.text.trim().length > 0);
        return EnvDefaults.renderCatalog(filtered);
    }
}
