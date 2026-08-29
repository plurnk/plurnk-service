// Client-input validation at the seam. Malformed external input becomes one
// exact public operation failure for every module riding the daemon surface.
// Internal invariant violations still throw ordinary implementation errors.
import { isAbsolute } from "node:path";
import Results, { OperationFailureError } from "../core/results.ts";
import FileCreationPolicy, { FILE_CREATE_SCOPES, type FileCreateScope } from "../core/file-creation-policy.ts";
import type { ProposalResolution } from "../core/ProposalLifecycle.ts";
import WorkerName, { WorkerNameError } from "../core/WorkerName.ts";
import {
    Validator,
    DEFAULT_LOOP_POLICY,
    type CapabilityPolicy,
    type LoopPolicy,
    type ClientInteractionResolution,
} from "@plurnk/plurnk-contracts";


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

    static assertOptionalSelector(context: string, field: "selector" | "childSelector", value: unknown): string | undefined {
        if (value === undefined) return undefined;
        if (typeof value !== "string" || value.length === 0) {
            const codeField = field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
            ClientInput.#invalid(
                context,
                `${codeField}-invalid`,
                `${field} is not a non-empty string.`,
                { field, recovery: "Provide a declared alias or provider/model route." },
            );
        }
        return value;
    }

    static assertSelector(context: string, field: "selector" | "childSelector", value: unknown): string {
        const selector = ClientInput.assertOptionalSelector(context, field, value);
        if (selector === undefined) {
            const codeField = field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
            ClientInput.#invalid(
                context,
                `${codeField}-invalid`,
                `${field} is required.`,
                { field, recovery: "Provide a declared alias or provider/model route." },
            );
        }
        return selector;
    }

    static assertOptionalChildSelector(context: string, value: unknown): string | null | undefined {
        if (value === null) return null;
        return ClientInput.assertOptionalSelector(context, "childSelector", value);
    }

    static assertChildSelector(context: string, value: unknown): string | null {
        if (value === null) return null;
        return ClientInput.assertSelector(context, "childSelector", value);
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

    static assertOptionalSource(context: string, source: unknown): string | undefined {
        if (source === undefined) return undefined;
        if (typeof source !== "string" || source.length === 0) {
            ClientInput.#invalid(
                context,
                "source-invalid",
                "source is not a non-empty string.",
                { field: "source", recovery: "Provide a canonical actor address or omit source." },
            );
        }
        return source;
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

    static normalizeLoopPolicy(context: string, policy: unknown): LoopPolicy {
        if (policy === undefined) return DEFAULT_LOOP_POLICY;
        if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
            ClientInput.#invalid(
                context,
                "loop-policy-invalid",
                "policy is not an object.",
                { field: "policy", recovery: "Provide capability policy and proposal disposition." },
            );
        }
        const partial = policy as { capabilities?: unknown; proposals?: unknown };
        if (Object.keys(partial).some((key) => key !== "capabilities" && key !== "proposals")) {
            ClientInput.#invalid(
                context,
                "loop-policy-invalid",
                "policy contains an unsupported field.",
                { field: "policy", recovery: "Use only capabilities and proposals." },
            );
        }
        const candidate = {
            capabilities: partial.capabilities ?? DEFAULT_LOOP_POLICY.capabilities,
            proposals: partial.proposals ?? DEFAULT_LOOP_POLICY.proposals,
        };
        try {
            return Validator.assertLoopPolicy(candidate as LoopPolicy);
        } catch {
            ClientInput.#invalid(
                context,
                "loop-policy-invalid",
                "policy is not a valid loop policy.",
                {
                    field: "policy",
                    recovery: "Use canonical capability only/deny selectors and proposals review, accept, or reject.",
                },
            );
        }
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
        const r = parsed as { filesItems?: unknown; maxCommands?: unknown; git?: unknown; fileCreateScope?: unknown; membersModelScope?: unknown; client?: unknown; capabilities?: unknown };
        const supported = new Set(["filesItems", "maxCommands", "git", "fileCreateScope", "membersModelScope", "client", "capabilities"]);
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
        const out: { filesItems?: number; maxCommands?: number; git?: boolean; fileCreateScope?: FileCreateScope; membersModelScope?: FileCreateScope; client?: string; capabilities?: CapabilityPolicy } = {};
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
        if (r.fileCreateScope !== undefined) {
            try {
                out.fileCreateScope = FileCreationPolicy.parse(r.fileCreateScope, "settings.fileCreateScope");
            } catch {
                ClientInput.#invalid(
                    "workspace.create",
                    "setting-invalid",
                    `settings.fileCreateScope ${JSON.stringify(r.fileCreateScope)} is not supported.`,
                    {
                        field: "settings.fileCreateScope",
                        allowedScopes: [...FILE_CREATE_SCOPES],
                        recovery: `Use one of ${FILE_CREATE_SCOPES.join(", ")}.`,
                    },
                );
            }
        }
        if (r.membersModelScope !== undefined) {
            try {
                out.membersModelScope = FileCreationPolicy.parse(r.membersModelScope, "settings.membersModelScope");
            } catch {
                ClientInput.#invalid(
                    "workspace.create",
                    "setting-invalid",
                    `settings.membersModelScope ${JSON.stringify(r.membersModelScope)} is not supported.`,
                    {
                        field: "settings.membersModelScope",
                        allowedScopes: [...FILE_CREATE_SCOPES],
                        recovery: `Use one of ${FILE_CREATE_SCOPES.join(", ")}.`,
                    },
                );
            }
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
        if (r.capabilities !== undefined) {
            try {
                out.capabilities = Validator.assertCapabilityPolicy(r.capabilities as CapabilityPolicy);
            } catch {
                ClientInput.#invalid(
                    "workspace.create",
                    "capability-policy-invalid",
                    "settings.capabilities is not a valid capability policy.",
                    { field: "settings.capabilities", recovery: "Provide canonical only/deny capability selectors." },
                );
            }
        }
        return JSON.stringify(out);
    }

    // {§worker-settings} — validate and serialize a worker's behavioral-rules bag.
    // Closed known-key set, validated here; unknown keys never persist. The worker
    // is an actor inside the workspace's world; these are its own rules.
    static normalizeWorkerSettings(raw: unknown): { capabilities?: CapabilityPolicy } {
        if (raw === undefined || raw === null) return {};
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
        const r = parsed as { capabilities?: unknown };
        const supported = new Set(["capabilities"]);
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
        const out: { capabilities?: CapabilityPolicy } = {};
        if (r.capabilities !== undefined) {
            try {
                out.capabilities = Validator.assertCapabilityPolicy(r.capabilities as CapabilityPolicy);
            } catch {
                ClientInput.#invalid(
                    "worker.settings",
                    "capability-policy-invalid",
                    "settings.capabilities is not a valid capability policy.",
                    { field: "settings.capabilities", recovery: "Provide canonical only/deny capability selectors." },
                );
            }
        }
        return out;
    }
}
