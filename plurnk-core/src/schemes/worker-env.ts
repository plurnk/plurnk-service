// SPEC {§exec-env-scoped} — the worker's own environment registry, layer four of the
// composition (package floors → operator cascade → ambient policy → WORKER DOCUMENT →
// the op's modifier → body prefixes).
//
// The registry is an ordinary worker-authority entry holding a dotenv document, which is
// the whole reason it works: it is per-worker because `authority` is the worker's name, it
// is addressable and READable by the model like any other resource, `disable` is a genuinely
// commented line rather than a flag in a table, and FORK already copies it because
// {§machine-processes-entry-inheritance} copies quiescent worker-authority entries.
//
// It deliberately does NOT live under `worker:///_plurnk/**`, which that anchor keeps SHARED
// across the workspace — the opposite of what a per-worker registry needs.
export const WORKER_ENV_PATHNAME = "/.env";

// A dotenv line the registry understands. A disabled entry is a commented assignment, so it
// survives round-trips and the model can see what it turned off.
export interface WorkerEnvEntry {
    readonly name: string;
    readonly value: string;
    readonly enabled: boolean;
}

// POSIX-ish, and deliberately narrow: a name the shell can actually export.
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export default class WorkerEnv {
    static isName(value: string): boolean {
        return NAME.test(value);
    }

    // Surrounding matched quotes are stripped; everything else is literal. No interpolation,
    // no escapes: a value the model wrote is the bytes it wrote.
    static #value(raw: string): string {
        const trimmed = raw.trim();
        const quote = trimmed[0];
        if ((quote === "\"" || quote === "'") && trimmed.length >= 2 && trimmed.endsWith(quote)) {
            return trimmed.slice(1, -1);
        }
        return trimmed;
    }

    static parse(document: string): readonly WorkerEnvEntry[] {
        const entries: WorkerEnvEntry[] = [];
        for (const line of document.split("\n")) {
            const bare = line.trim();
            if (bare.length === 0) continue;
            const enabled = !bare.startsWith("#");
            // A commented line is an entry only when it is a commented ASSIGNMENT; prose stays prose.
            const body = enabled ? bare : bare.replace(/^#+\s*/u, "");
            const split = body.indexOf("=");
            if (split < 1) continue;
            const name = body.slice(0, split).trim();
            if (!NAME.test(name)) continue;
            entries.push({ name, value: WorkerEnv.#value(body.slice(split + 1)), enabled });
        }
        return entries;
    }

    // Render back, preserving the disabled/enabled distinction as comment state.
    static render(entries: readonly WorkerEnvEntry[]): string {
        return entries.map(({ name, value, enabled }) => `${enabled ? "" : "# "}${name}=${value}`).join("\n");
    }

    // The document's contribution over an already-composed ambient environment. The ambient
    // ceiling does not apply here — these are the worker's own values, not the host's — but
    // the invariant does, so a model cannot introduce a `PLURNK_*` or provider-credential name
    // by writing one into its own registry.
    static compose(
        ambient: NodeJS.ProcessEnv,
        document: string,
        isOwnSecret: (name: string) => boolean,
    ): NodeJS.ProcessEnv {
        const out: NodeJS.ProcessEnv = { ...ambient };
        for (const { name, value, enabled } of WorkerEnv.parse(document)) {
            if (isOwnSecret(name)) continue;
            // A disabled entry is the worker masking a name for itself, including one the
            // ambient policy admitted — that is how a worker turns off `CI=1` without the operator.
            if (!enabled) { delete out[name]; continue; }
            out[name] = value;
        }
        return out;
    }
}
