// Client-input validation at the seam. Malformed external input becomes one
// exact public operation failure for every module riding the daemon surface.
// Internal invariant violations still throw ordinary implementation errors.
import { isAbsolute } from "node:path";
import { Policy } from "@plurnk/plurnk-execs";
import Results, { OperationFailureError } from "../core/results.ts";
import type { ProposalResolution } from "../core/ProposalLifecycle.ts";
import WorkerName, { WorkerNameError } from "../core/WorkerName.ts";
import {
    Validator,
    type ClientInteractionResolution,
} from "@plurnk/plurnk-contracts";

const CONSTRAINT_EFFECTS: ReadonlySet<string> = new Set(["pick", "hide", "view"]);

export default class ClientInput {
    static #invalid(
        context: string,
        code: string,
        detail: string,
        extensions: Readonly<Record<string, unknown>> = {},
    ): never {
        throw new OperationFailureError(Results.failure(
            "daemon:input",
            code,
            400,
            detail,
            {},
            {
                context,
                stage: "input-validation",
                retryable: false,
                ...extensions,
            },
        ));
    }

    // A workspace pin must be an absolute path (or null = headless) - a relative root would
    // silently resolve against the daemon's cwd, never the client's.
    static assertProjectRoot(context: string, projectRoot: unknown): string | null {
        const root = (projectRoot as string | null | undefined) ?? null;
        if (root === null) return null;
        if (typeof root !== "string" || root.length === 0) {
            ClientInput.#invalid(
                context,
                "project-root-invalid",
                "projectRoot is neither a non-empty string nor null.",
                { field: "projectRoot", recovery: "Provide an absolute project path or null." },
            );
        }
        if (!isAbsolute(root)) {
            ClientInput.#invalid(
                context,
                "project-root-not-absolute",
                `projectRoot '${root}' is not an absolute path.`,
                { field: "projectRoot", value: root, recovery: "Provide an absolute project path." },
            );
        }
        return root;
    }

    static assertOptionalName(context: string, field: string, value: unknown): string | undefined {
        if (value === undefined) return undefined;
        if (typeof value !== "string" || value.length === 0) {
            ClientInput.#invalid(
                context,
                "name-invalid",
                `${field} is not a non-empty string.`,
                { field, recovery: `Provide a non-empty ${field}.` },
            );
        }
        return value;
    }

    static assertOptionalWorkerName(context: string, field: string, value: unknown): string | undefined {
        const workerName = ClientInput.assertOptionalName(context, field, value);
        if (workerName === undefined) return undefined;
        try {
            return WorkerName.assert(workerName);
        } catch (error) {
            if (!(error instanceof WorkerNameError)) throw error;
            throw new OperationFailureError(Results.failure(
                "daemon:worker",
                error.code,
                error.rejection === "reserved" ? 409 : 400,
                error.message,
                {},
                {
                    context,
                    field,
                    name: error.workerName,
                    recovery: error.recovery,
                    retryable: false,
                },
            ));
        }
    }

    static assertOptionalSelector(context: string, field: "alias" | "model" | "childAlias" | "childModel", value: unknown): string | undefined {
        if (value === undefined) return undefined;
        if (typeof value !== "string" || value.length === 0) {
            const codeField = field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
            ClientInput.#invalid(
                context,
                `${codeField}-invalid`,
                `${field} is not a non-empty string.`,
                { field, recovery: `Provide a non-empty provider ${field}.` },
            );
        }
        return value;
    }

    static assertOptionalChildAlias(context: string, value: unknown): string | null | undefined {
        if (value === null) return null;
        return ClientInput.assertOptionalSelector(context, "childAlias", value);
    }

    static assertOptionalChannel(context: string, channel: unknown): string | undefined {
        if (channel === undefined) return undefined;
        if (typeof channel !== "string" || channel.length === 0) {
            ClientInput.#invalid(
                context,
                "channel-invalid",
                "channel is not a non-empty string.",
                { field: "channel", recovery: "Provide a non-empty channel name." },
            );
        }
        return channel;
    }

    static assertId(context: string, field: string, value: unknown): number {
        if (!Number.isSafeInteger(value) || (value as number) < 1) {
            ClientInput.#invalid(
                context,
                "identifier-invalid",
                `${field} is not a positive safe integer.`,
                { field, value, recovery: `Provide a valid ${field}.` },
            );
        }
        return value as number;
    }

    static assertPrompt(context: string, prompt: unknown): string {
        if (typeof prompt !== "string" || prompt.length === 0) {
            ClientInput.#invalid(
                context,
                "prompt-invalid",
                "prompt is not a non-empty string.",
                { field: "prompt", recovery: "Provide a non-empty prompt." },
            );
        }
        return prompt;
    }

    static assertMaxTurns(context: string, maxTurns: unknown): number | undefined {
        if (maxTurns === undefined) return undefined;
        if (!Number.isSafeInteger(maxTurns) || (maxTurns as number) < -1) {
            ClientInput.#invalid(
                context,
                "max-turns-invalid",
                "maxTurns is neither -1 nor a non-negative safe integer.",
                {
                    field: "maxTurns",
                    value: maxTurns,
                    recovery: "Use -1 for no per-call ceiling or a non-negative integer ceiling.",
                },
            );
        }
        return maxTurns as number;
    }

    static assertOpenPaths(context: string, openPaths: unknown): string[] | undefined {
        if (openPaths === undefined) return undefined;
        if (!Array.isArray(openPaths)) {
            ClientInput.#invalid(
                context,
                "open-paths-invalid",
                "openPaths is not an array.",
                { field: "openPaths", recovery: "Provide an array of non-empty paths." },
            );
        }
        for (let i = 0; i < openPaths.length; i++) {
            if (typeof openPaths[i] !== "string" || openPaths[i].length === 0) {
                ClientInput.#invalid(
                    context,
                    "open-path-invalid",
                    `openPaths[${i}] is not a non-empty string.`,
                    { field: `openPaths[${i}]`, recovery: "Provide a non-empty path." },
                );
            }
        }
        return openPaths as string[];
    }

    static assertLimit(context: string, limit: unknown): number | undefined {
        if (limit === undefined) return undefined;
        if (!Number.isSafeInteger(limit) || (limit as number) < 1) {
            ClientInput.#invalid(
                context,
                "limit-invalid",
                "limit is not a positive safe integer.",
                { field: "limit", value: limit, recovery: "Use a positive integer limit." },
            );
        }
        return limit as number;
    }

    static assertProposalResolution(context: string, resolution: unknown): ProposalResolution {
        if (typeof resolution !== "object" || resolution === null || Array.isArray(resolution)) {
            ClientInput.#invalid(
                context,
                "proposal-resolution-invalid",
                "resolution is not an object.",
                { field: "resolution", recovery: "Provide a proposal decision." },
            );
        }
        const value = resolution as Record<string, unknown>;
        const supported = new Set(["decision", "body", "outcome"]);
        for (const key of Object.keys(value)) {
            if (!supported.has(key)) {
                ClientInput.#invalid(
                    context,
                    "proposal-resolution-field-not-supported",
                    `resolution.${key} is not supported.`,
                    {
                        field: `resolution.${key}`,
                        supportedFields: [...supported],
                        recovery: "Remove the unsupported proposal resolution field.",
                    },
                );
            }
        }
        if (value.decision !== "accept" && value.decision !== "reject" && value.decision !== "cancel") {
            ClientInput.#invalid(
                context,
                "proposal-decision-invalid",
                "resolution.decision is not accept, reject, or cancel.",
                {
                    field: "resolution.decision",
                    allowedDecisions: ["accept", "reject", "cancel"],
                    recovery: "Use an allowed proposal decision.",
                },
            );
        }
        if (value.body !== undefined && typeof value.body !== "string") {
            ClientInput.#invalid(
                context,
                "proposal-body-invalid",
                "resolution.body is not a string.",
                { field: "resolution.body", recovery: "Provide a string body or omit it." },
            );
        }
        if (value.outcome !== undefined && (typeof value.outcome !== "string" || value.outcome.length === 0)) {
            ClientInput.#invalid(
                context,
                "proposal-outcome-invalid",
                "resolution.outcome is not a non-empty string.",
                { field: "resolution.outcome", recovery: "Provide a non-empty outcome or omit it." },
            );
        }
        return {
            decision: value.decision,
            ...(value.body === undefined ? {} : { body: value.body }),
            ...(value.outcome === undefined ? {} : { outcome: value.outcome }),
        } as ProposalResolution;
    }

    static assertClientInteractionResolution(
        context: string,
        resolution: unknown,
    ): ClientInteractionResolution {
        try {
            return Validator.assertClientInteractionResolution(
                resolution as ClientInteractionResolution,
            );
        } catch {
            ClientInput.#invalid(
                context,
                "interaction-resolution-invalid",
                "resolution is not a valid client interaction resolution.",
                {
                    field: "resolution",
                    recovery: "Resolve with status 'resolved' and an optional payload, or status 'cancelled'.",
                },
            );
        }
    }

    static assertConstraint(context: string, effect: unknown, glob: unknown): void {
        if (typeof effect !== "string" || !CONSTRAINT_EFFECTS.has(effect)) {
            ClientInput.#invalid(
                context,
                "constraint-effect-invalid",
                `Constraint effect ${JSON.stringify(effect)} is not supported.`,
                {
                    field: "effect",
                    allowedEffects: [...CONSTRAINT_EFFECTS],
                    recovery: "Use one of the allowed constraint effects.",
                },
            );
        }
        if (typeof glob !== "string" || glob.length === 0) {
            ClientInput.#invalid(
                context,
                "constraint-glob-invalid",
                "Constraint glob is not a non-empty string.",
                { field: "glob", recovery: "Provide a non-empty constraint glob." },
            );
        }
    }

    static parseConstraints(raw: unknown): Array<{ effect: string; glob: string }> {
        if (raw === undefined || raw === null) return [];
        if (!Array.isArray(raw)) {
            ClientInput.#invalid(
                "workspace.create",
                "constraints-invalid",
                "constraints is not an array.",
                { field: "constraints", recovery: "Provide an array of constraint objects." },
            );
        }
        return raw.map((c, i) => {
            if (typeof c !== "object" || c === null || Array.isArray(c)) {
                ClientInput.#invalid(
                    "workspace.create",
                    "constraint-invalid",
                    `constraints[${i}] is not an object.`,
                    {
                        field: `constraints[${i}]`,
                        recovery: "Provide an object with effect and glob fields.",
                    },
                );
            }
            const e = c as { effect?: unknown; glob?: unknown };
            if (typeof e.effect !== "string" || !CONSTRAINT_EFFECTS.has(e.effect)) {
                ClientInput.#invalid(
                    "workspace.create",
                    "constraint-effect-invalid",
                    `constraints[${i}].effect ${JSON.stringify(e.effect)} is not supported.`,
                    {
                        field: `constraints[${i}].effect`,
                        allowedEffects: [...CONSTRAINT_EFFECTS],
                        recovery: "Use one of the allowed constraint effects.",
                    },
                );
            }
            if (typeof e.glob !== "string" || e.glob.length === 0) {
                ClientInput.#invalid(
                    "workspace.create",
                    "constraint-glob-invalid",
                    `constraints[${i}].glob is not a non-empty string.`,
                    {
                        field: `constraints[${i}].glob`,
                        recovery: "Provide a non-empty constraint glob.",
                    },
                );
            }
            return { effect: e.effect, glob: e.glob };
        });
    }

    // Loop flags are booleans (mode aside); a truthy string silently flipping
    // auto-approval would be a review bypass, so the public surface rejects it.
    static normalizeLoopFlags(context: string, flags: unknown): Record<string, unknown> | undefined {
        if (flags === undefined) return undefined;
        if (typeof flags !== "object" || flags === null || Array.isArray(flags)) {
            ClientInput.#invalid(
                context,
                "loop-flags-invalid",
                "flags is not an object.",
                { field: "flags", recovery: "Provide an object containing supported loop flags." },
            );
        }
        const f = flags as Record<string, unknown>;
        const booleanFlags = new Set(["auto", "noProposals", "noWeb", "noInteraction"]);
        const allowed = new Set([...booleanFlags, "mode"]);
        for (const key of Object.keys(f)) {
            if (!allowed.has(key)) {
                ClientInput.#invalid(
                    context,
                    "loop-flag-not-supported",
                    `Loop flag '${key}' is not supported.`,
                    {
                        field: `flags.${key}`,
                        allowedFlags: [...allowed],
                        recovery: "Remove the unsupported loop flag.",
                    },
                );
            }
        }
        for (const bool of booleanFlags) {
            if (f[bool] !== undefined && typeof f[bool] !== "boolean") {
                ClientInput.#invalid(
                    context,
                    "loop-flag-invalid",
                    `Loop flag '${bool}' is not boolean.`,
                    { field: `flags.${bool}`, recovery: "Use true or false for this loop flag." },
                );
            }
        }
        if (f.mode !== undefined && f.mode !== "ask" && f.mode !== "act") {
            ClientInput.#invalid(
                context,
                "loop-mode-invalid",
                `Loop mode ${JSON.stringify(f.mode)} is not supported.`,
                {
                    field: "flags.mode",
                    allowedModes: ["ask", "act"],
                    recovery: "Use loop mode 'ask' or 'act'.",
                },
            );
        }
        return f;
    }

    // {§operator-config} — validate and serialize the client open-context bag. filesItems is a scalar (replace);
    // mdDocs is [{alias, content}] (union'd with env at turn-0). A module may
    // serialize the object at its edge; core still parses and validates it here.
    static parseSettings(raw: unknown): string {
        if (raw === undefined || raw === null) return "{}";
        let parsed: unknown = raw;
        if (typeof raw === "string") {
            try {
                parsed = JSON.parse(raw) as unknown;
            } catch {
                ClientInput.#invalid(
                    "workspace.create",
                    "settings-invalid",
                    "settings is not valid JSON.",
                    { field: "settings", recovery: "Provide a JSON object." },
                );
            }
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            ClientInput.#invalid(
                "workspace.create",
                "settings-invalid",
                "settings is not an object.",
                { field: "settings", recovery: "Provide a settings object." },
            );
        }
        const r = parsed as { filesItems?: unknown; maxCommands?: unknown; git?: unknown; client?: unknown; execs?: unknown };
        const supported = new Set(["filesItems", "maxCommands", "git", "client", "execs"]);
        for (const key of Object.keys(r)) {
            if (!supported.has(key)) {
                ClientInput.#invalid(
                    "workspace.create",
                    "setting-not-supported",
                    `settings.${key} is not supported.`,
                    {
                        field: `settings.${key}`,
                        supportedSettings: [...supported],
                        recovery: "Remove the unsupported setting.",
                    },
                );
            }
        }
        const out: { filesItems?: number; maxCommands?: number; git?: boolean; client?: string; execs?: Record<string, string> } = {};
        if (r.filesItems !== undefined) {
            if (typeof r.filesItems !== "number" || !Number.isInteger(r.filesItems) || r.filesItems < -1) {
                ClientInput.#invalid(
                    "workspace.create",
                    "setting-invalid",
                    `settings.filesItems ${JSON.stringify(r.filesItems)} is not an integer.`,
                    {
                        field: "settings.filesItems",
                        recovery: "Use -1 for all files, 0 for none, or a positive first-N limit.",
                    },
                );
            }
            out.filesItems = r.filesItems;
        }
        // {§operator-config} — tighten-only ceilings: a client may narrow, never widen (composed
        // most-restrictive-wins at each read-site). maxCommands min()s the env ceiling;
        // git:false denies git for the workspace (env AND workspace).
        if (r.maxCommands !== undefined) {
            if (typeof r.maxCommands !== "number" || !Number.isInteger(r.maxCommands) || r.maxCommands < 0) {
                ClientInput.#invalid(
                    "workspace.create",
                    "setting-invalid",
                    `settings.maxCommands ${JSON.stringify(r.maxCommands)} is not a non-negative integer.`,
                    {
                        field: "settings.maxCommands",
                        recovery: "Use a non-negative integer command ceiling.",
                    },
                );
            }
            out.maxCommands = r.maxCommands;
        }
        if (r.git !== undefined) {
            if (typeof r.git !== "boolean") {
                ClientInput.#invalid(
                    "workspace.create",
                    "setting-invalid",
                    "settings.git is not boolean.",
                    { field: "settings.git", recovery: "Use true or false for settings.git." },
                );
            }
            out.git = r.git;
        }
        // {§client-metadata} — workspace-stable frontend id (e.g. "plurnk.nvim/1.4.0"), forwarded to the plurnk
        // provider as Plurnk-Client metadata; ignored by every other provider. Self-identified.
        if (r.client !== undefined) {
            if (typeof r.client !== "string" || r.client.length === 0) {
                ClientInput.#invalid(
                    "workspace.create",
                    "setting-invalid",
                    "settings.client is not a non-empty string.",
                    { field: "settings.client", recovery: "Provide the client identifier." },
                );
            }
            out.client = r.client;
        }
        // {§operator-config-workspace-execs} — retain the admitted policy map as
        // the workspace snapshot. MCP connection configuration remains daemon-owned.
        if (r.execs !== undefined) {
            if (typeof r.execs !== "object" || r.execs === null || Array.isArray(r.execs)) {
                ClientInput.#invalid(
                    "workspace.create",
                    "setting-invalid",
                    "settings.execs is not an object.",
                    {
                        field: "settings.execs",
                        recovery: "Provide an object of PLURNK_EXECS_* string values.",
                    },
                );
            }
            const execs: Record<string, string> = {};
            for (const [k, v] of Object.entries(r.execs as Record<string, unknown>)) {
                if (/^PLURNK_(?:EXECS_)?MCP_/i.test(k)) {
                    ClientInput.#invalid(
                        "workspace.create",
                        "mcp-configuration-forbidden",
                        `settings.execs key '${k}' contains MCP server configuration rather than workspace policy.`,
                        { field: `settings.execs.${k}`, recovery: "Configure MCP servers outside workspace settings." },
                    );
                }
                if (!Policy.isKey(k)) {
                    ClientInput.#invalid(
                        "workspace.create",
                        "setting-key-invalid",
                        `settings.execs key '${k}' is not a runtime policy key.`,
                        {
                            field: `settings.execs.${k}`,
                            recovery: "Use PLURNK_EXECS_ONLY or PLURNK_EXECS_<canonical runtime tag>.",
                        },
                    );
                }
                if (typeof v !== "string") {
                    ClientInput.#invalid(
                        "workspace.create",
                        "setting-invalid",
                        `settings.execs['${k}'] is not a string.`,
                        { field: `settings.execs.${k}`, recovery: "Use a string policy value." },
                    );
                }
                execs[k] = v;
            }
            out.execs = execs;
        }
        return JSON.stringify(out);
    }

    // {§worker-settings} — validate and serialize a worker's behavioral-rules bag.
    // Closed known-key set, validated here; unknown keys never persist. The worker
    // is an actor inside the workspace's world; these are its own rules.
    static parseWorkerSettings(raw: unknown): string {
        if (raw === undefined || raw === null) return "{}";
        let parsed: unknown = raw;
        if (typeof raw === "string") {
            try {
                parsed = JSON.parse(raw) as unknown;
            } catch {
                ClientInput.#invalid(
                    "worker.settings",
                    "settings-invalid",
                    "worker settings is not valid JSON.",
                    { field: "settings", recovery: "Provide a JSON object." },
                );
            }
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            ClientInput.#invalid(
                "worker.settings",
                "settings-invalid",
                "worker settings is not an object.",
                { field: "settings", recovery: "Provide a settings object." },
            );
        }
        const r = parsed as { requestUserInput?: unknown };
        const supported = new Set(["requestUserInput"]);
        for (const key of Object.keys(r)) {
            if (!supported.has(key)) {
                ClientInput.#invalid(
                    "worker.settings",
                    "setting-not-supported",
                    `settings.${key} is not supported.`,
                    {
                        field: `settings.${key}`,
                        supportedSettings: [...supported],
                        recovery: "Remove the unsupported setting.",
                    },
                );
            }
        }
        const out: { requestUserInput?: boolean } = {};
        if (r.requestUserInput !== undefined) {
            if (typeof r.requestUserInput !== "boolean") {
                ClientInput.#invalid(
                    "worker.settings",
                    "setting-invalid",
                    "settings.requestUserInput is not boolean.",
                    { field: "settings.requestUserInput", recovery: "Use true or false for settings.requestUserInput." },
                );
            }
            out.requestUserInput = r.requestUserInput;
        }
        return JSON.stringify(out);
    }
}
