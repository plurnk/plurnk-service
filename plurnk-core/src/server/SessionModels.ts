// The session's model: which provider, model and effort a session or loop runs on — the durable selection and its
// spawn override, their client get/set surface, per-turn loop policy resolution, and the catalog a client lists.
// Split out of Daemon, which keeps the delegating entry points.
import type { Db } from "../core/Db.ts";
import type { CurationOverflow } from "../core/PacketBuilder.ts";
import type { Provider, ProviderSpec } from "@plurnk/plurnk-providers";
import { projectModelRoute, routeForSpec, specForRoute } from "./model-route.ts";
import { EFFORTS, Validator, type Effort, type ModelCatalogPage, type ModelCatalogQuery, type ModelRoute } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { parseAliasesFromEnv, resolveActiveRoute, resolveChildRoute, UnsupportedEffortError } from "@plurnk/plurnk-providers";
import ConfigurationError from "@plurnk/plurnk-meta/configuration-error";
import ProviderInstantiate from "../core/ProviderInstantiate.ts";
import { resolveLoopRoute } from "./loop-model.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import { daemonFailure, modelRouteLabel } from "./daemon-results.ts";
import ClientInput from "./client-input.ts";
import { listModelCatalog } from "./model-catalog.ts";

export type EffortSource = "default" | "explicit";
export type SessionGenerationPolicyRow = {
    model_route_id: number | null;
    spawn_model_route_id: number | null;
    effort: Effort | null;
    // {§session-model-selection} — `explicit` only through session.effort.set.
    effort_source: EffortSource;
};
type LoopGenerationPolicy = {
    providerSpec: ProviderSpec;
    childProviderSpec: ProviderSpec | null;
    effort: Effort;
};

// {§operation-results} A session with no model to run, whether a selection or a loop found none.
const providerNotConfigured = (): OperationFailureError => new OperationFailureError(Results.failure(
    "daemon:provider",
    "not-configured",
    501,
    "No provider is configured for this session.",
    {},
    {
        stage: "provider-selection",
        recovery: "Select a model for this session, or set `PLURNK_MODEL=<provider/model>` as the service default; that provider's API key must be in the service's environment.",
        retryable: false,
    },
));

export default class SessionModels {
    readonly #db: Db;
    // The boot provider, whose input capacity the active alias reports ({§acp-status-descendants}).
    readonly #provider: Provider | null;
    // {§notifications} Told of each write that changed a session's stored policy.
    readonly #policyChanged: (sessionId: number) => Promise<void>;
    // {§session-model-selection} Measures whether the session's current curated context fits a target model's budget.
    readonly #sessionCurationOverflow: (sessionId: number, provider: Provider) => Promise<CurationOverflow | null>;
    // Serialize policy read-validate-write operations per session so concurrent updates commit and announce in order.
    readonly #policyLocks = new Map<number, Promise<unknown>>();

    constructor({ db, provider, policyChanged = async () => {}, sessionCurationOverflow = async () => null }: {
        db: Db;
        provider: Provider | null;
        policyChanged?: (sessionId: number) => Promise<void>;
        sessionCurationOverflow?: (sessionId: number, provider: Provider) => Promise<CurationOverflow | null>;
    }) {
        this.#db = db;
        this.#provider = provider;
        this.#policyChanged = policyChanged;
        this.#sessionCurationOverflow = sessionCurationOverflow;
    }

    #withPolicyLock<T>(sessionId: number, write: () => Promise<T>): Promise<T> {
        const previous = this.#policyLocks.get(sessionId) ?? Promise.resolve();
        const run = previous.then(write, write);
        const tail = run.catch(() => {});
        this.#policyLocks.set(sessionId, tail);
        void tail.then(() => {
            if (this.#policyLocks.get(sessionId) === tail) this.#policyLocks.delete(sessionId);
        });
        return run;
    }

    persistGenerationPolicy(
        sessionId: number,
        policy: SessionGenerationPolicyRow,
        options?: { readonly spawn?: boolean },
    ): Promise<readonly Effort[]> {
        return this.#withPolicyLock(sessionId, () => this.#persistPolicy(sessionId, policy, options));
    }

    async #persistPolicy(
        sessionId: number,
        policy: SessionGenerationPolicyRow,
        options?: { readonly spawn?: boolean },
    ): Promise<readonly Effort[]> {
        const supportedEfforts = await this.supportedEfforts(policy);
        const stored = await this.#db.session_generation_policy_read.get<SessionGenerationPolicyRow>({ id: sessionId });
        if (options?.spawn !== true && policy.model_route_id !== null && stored?.model_route_id !== policy.model_route_id) {
            await this.#assertContextFitsModel(sessionId, policy.model_route_id, policy.effort ?? undefined);
        }
        const updated = await this.#db.session_generation_policy_update.get({ id: sessionId, ...policy });
        if (updated === undefined) {
            throw new Error(`session ${sessionId}: generation policy row missing`);
        }
        // {§notifications} A write that changed the stored policy is announced; one that changed nothing is not.
        if (stored === undefined || stored.model_route_id !== policy.model_route_id || stored.spawn_model_route_id !== policy.spawn_model_route_id
            || stored.effort !== policy.effort || stored.effort_source !== policy.effort_source) await this.#policyChanged(sessionId);
        return supportedEfforts;
    }

    // {§session-model-selection} — a model switch cannot select a model whose calibrated budget cannot hold
    // the session's current context; the session curates first or chooses a larger model.
    async #assertContextFitsModel(sessionId: number, routeId: number, effort: Effort | undefined): Promise<void> {
        const spec = await specForRoute(this.#db, routeId);
        if (spec === null) throw new Error(`model route ${routeId} is missing`);
        const provider = await this.providerForPolicy(spec, effort);
        const overflow = await this.#sessionCurationOverflow(sessionId, provider);
        if (overflow === null) return;
        throw daemonFailure(
            "daemon:provider",
            "context-exceeds-model-budget",
            413,
            `Current context (${overflow.weight} tokens) does not fit in ${modelRouteLabel(spec)} (budget: ${overflow.budget} tokens).`,
            {
                sessionId,
                ...(spec.alias === undefined ? {} : { alias: spec.alias }),
                provider: spec.provider,
                model: spec.model,
                tokens: overflow.weight,
                budget: overflow.budget,
                excess: overflow.excess,
                stage: "model-selection",
                recovery: `Curate context below ${overflow.budget} tokens or select a larger model.`,
                retryable: false,
            },
        );
    }

    async supportedEfforts(policy: SessionGenerationPolicyRow): Promise<readonly Effort[]> {
        let supportedEfforts: readonly Effort[] | undefined;
        for (const routeId of [policy.model_route_id, policy.spawn_model_route_id]) {
            if (routeId === null) continue;
            const spec = await specForRoute(this.#db, routeId);
            if (spec === null) throw new Error(`model route ${routeId} is missing`);
            const provider = await this.providerForPolicy(spec, policy.effort ?? undefined);
            supportedEfforts = supportedEfforts === undefined
                ? provider.supportedEfforts
                : supportedEfforts.filter((candidate) => provider.supportedEfforts.includes(candidate));
        }
        return supportedEfforts ?? [];
    }

    // {§session-model-selection} — a model session owns one durable model. An explicit
    // selector persists onto the session; an omitted selector resolves the session's
    // durable model, seeded once from the daemon default. A deliberately modelless
    // daemon leaves the session unset until an explicit selection arrives.
    resolveSessionModel(
        sessionId: number,
        selector: string | undefined,
        chosen?: Effort,
    ): Promise<{ providerSpec: ProviderSpec; effort: Effort; effortSource: EffortSource } | null> {
        return this.#withPolicyLock(sessionId, () => this.#resolveModelUnlocked(sessionId, selector, chosen));
    }

    async #resolveModelUnlocked(
        sessionId: number,
        selector: string | undefined,
        chosen?: Effort,
    ): Promise<{ providerSpec: ProviderSpec; effort: Effort; effortSource: EffortSource } | null> {
        const session = await this.#db.session_generation_policy_read.get<SessionGenerationPolicyRow>({ id: sessionId });
        if (session === undefined) throw new Error(`session ${sessionId}: model route row missing`);
        if (selector !== undefined) {
            const spec = this.#resolveLoopProvider(selector);
            if (spec === null) return null;
            // {§session-model-selection} — a chosen effort follows the session across models; a seeded one
            // re-derives from the new alias, so a default never outlives its alias. An effort chosen with the
            // model replaces the carried one, and the pair is validated as one.
            const explicit = chosen !== undefined || session.effort_source === "explicit" && session.effort !== null;
            const effort = chosen ?? (explicit
                ? session.effort!
                : this.#configuredEffort(spec));
            const effortSource: EffortSource = explicit ? "explicit" : "default";
            await this.#persistPolicy(sessionId, {
                model_route_id: await routeForSpec(this.#db, spec),
                spawn_model_route_id: session.spawn_model_route_id,
                effort,
                effort_source: effortSource });
            return { providerSpec: spec, effort, effortSource };
        }
        if (session.model_route_id !== null) {
            if (session.effort === null) {
                throw new Error(`session ${sessionId}: durable model has no effort`);
            }
            const spec = await specForRoute(this.#db, session.model_route_id);
            if (spec === null) throw new Error(`session ${sessionId}: model route is missing`);
            await this.providerForPolicy(spec, session.effort);
            return { providerSpec: spec, effort: session.effort, effortSource: session.effort_source };
        }
        const spec = this.#configured(() => resolveActiveRoute());
        if (spec !== null) {
            const effort = this.#configuredEffort(spec);
            await this.#persistPolicy(sessionId, {
                model_route_id: await routeForSpec(this.#db, spec),
                spawn_model_route_id: session.spawn_model_route_id,
                effort,
                effort_source: "default" });
            return { providerSpec: spec, effort, effortSource: "default" };
        }
        return null;
    }

    // {§session-model-selection} — the persistent spawn override. An explicit child
    // selector persists onto the session (null clears it back to inherit); an omitted
    // selector resolves the persisted override, seeded once from the operator's
    // PLURNK_MODEL_CHILD default (unless preserving an open loop's spawn policy on injection).
    resolveSessionSpawnModel(sessionId: number, childSelector: string | null | undefined): Promise<ProviderSpec | null> {
        return this.#withPolicyLock(sessionId, () => this.#resolveSpawnModelUnlocked(sessionId, childSelector, true));
    }

    async #resolveSpawnModelUnlocked(
        sessionId: number,
        childSelector: string | null | undefined,
        seedDefaultWhenUnset: boolean,
    ): Promise<ProviderSpec | null> {
        const session = await this.#db.session_generation_policy_read.get<SessionGenerationPolicyRow>({ id: sessionId });
        if (session === undefined) throw new Error(`session ${sessionId}: model route row missing`);
        if (childSelector !== undefined) {
            const spec = childSelector === null
                ? null
                : this.#resolveLoopProvider(childSelector);
            await this.#persistPolicy(sessionId, {
                model_route_id: session.model_route_id,
                spawn_model_route_id: spec === null ? null : await routeForSpec(this.#db, spec),
                effort: session.effort,
                effort_source: session.effort_source });
            return spec;
        }
        if (session.spawn_model_route_id !== null) {
            const spec = await specForRoute(this.#db, session.spawn_model_route_id);
            if (spec === null) throw new Error(`session ${sessionId}: spawn model route is missing`);
            if (session.effort !== null) {
                await this.providerForPolicy(spec, session.effort);
            }
            return spec;
        }
        if (!seedDefaultWhenUnset) return null;
        const spec = this.#configured(() => resolveChildRoute());
        if (spec !== null) {
            await this.#persistPolicy(sessionId, {
                model_route_id: session.model_route_id,
                spawn_model_route_id: await routeForSpec(this.#db, spec),
                effort: session.effort,
                effort_source: session.effort_source });
        }
        return spec;
    }

    // {§session-model-selection}: read-only preflight before preparing message attachments so an unconfigured
    // session fails with 501 before allocating attachment entries.
    async assertRunLoopConfigured(sessionId: number, selector: string | undefined): Promise<void> {
        if (selector !== undefined) {
            if (this.#resolveLoopProvider(selector) === null) throw providerNotConfigured();
            return;
        }
        const session = await this.#db.session_generation_policy_read.get<SessionGenerationPolicyRow>({ id: sessionId });
        if (session === undefined) throw new Error(`session ${sessionId}: model route row missing`);
        if (session.model_route_id !== null) return;
        if (this.#configured(() => resolveActiveRoute()) === null) throw providerNotConfigured();
    }

    // {§session-model-selection}: resolve and persist runLoop's generation policy once loop admission checks pass.
    // On an injection into an open loop, an omitted childSelector preserves the loop's existing spawn policy.
    applyRunLoopPolicy(args: {
        sessionId: number;
        selector: string | undefined;
        childSelector: string | null | undefined;
        activeLoopId: number | undefined;
    }): Promise<{ providerSpec: ProviderSpec; effort: Effort; childProviderSpec: ProviderSpec | null }> {
        return this.#withPolicyLock(args.sessionId, async () => {
            const generationPolicy = await this.#resolveModelUnlocked(args.sessionId, args.selector);
            if (generationPolicy === null) throw providerNotConfigured();
            const childProviderSpec = await this.#resolveSpawnModelUnlocked(
                args.sessionId,
                args.childSelector,
                args.activeLoopId === undefined,
            );
            return {
                providerSpec: generationPolicy.providerSpec,
                effort: generationPolicy.effort,
                childProviderSpec,
            };
        });
    }


    // Resolve eagerly so runLoop fails before enqueue when the selected route
    // and durable effort cannot compose. The drain later retrieves
    // this cached handle from the loop's immutable snapshot.
    async providerForPolicy(
        spec: ProviderSpec,
        effort?: Effort,
    ): Promise<Provider> {
        try {
            return await ProviderInstantiate.instantiateProvider(
                spec,
                process.env,
                effort,
            );
        } catch (cause) {
            if (cause instanceof OperationFailureError) throw cause;
            if (cause instanceof ConfigurationError) throw new OperationFailureError(Results.configurationFailure(cause), { cause });
            if (cause instanceof UnsupportedEffortError) {
                throw daemonFailure(
                    "daemon:provider",
                    "effort-unsupported",
                    409,
                    `${modelRouteLabel(spec)} does not support effort '${cause.policy}'.`,
                    {
                        ...(spec.alias === undefined ? {} : { alias: spec.alias }),
                        provider: spec.provider,
                        model: spec.model,
                        effort: cause.policy,
                        supportedEfforts: cause.supported,
                        stage: "provider-selection",
                        recovery: `Select one of the provider's supported efforts: ${cause.supported.join(", ")}.`,
                        retryable: false },
                );
            }
            console.error(`${modelRouteLabel(spec)} could not be instantiated:`, cause);
            const reason = cause instanceof Error && cause.message.length > 0 ? ` ${cause.message}` : "";
            throw daemonFailure(
                "daemon:provider",
                "provider-unavailable",
                503,
                `${modelRouteLabel(spec)} is unavailable.${reason}`,
                {
                    ...(spec.alias === undefined ? {} : { alias: spec.alias }),
                    provider: spec.provider,
                    model: spec.model,
                    stage: "provider-selection",
                    retryable: false },
            );
        }
    }


    // {§session-model-selection}: resolve identity without provider setup.
    #resolveLoopProvider(selector: string): ProviderSpec | null {
        return this.#configured(() => resolveLoopRoute(selector, selector.includes("/") ? [] : parseAliasesFromEnv()));
    }

    #configured<T>(read: () => T): T {
        try { return read(); }
        catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            throw new OperationFailureError(Results.configurationFailure(cause), { cause });
        }
    }

    #configuredEffort(spec: ProviderSpec): Effort {
        try { return ProviderInstantiate.configuredEffort(spec); }
        catch (cause) {
            const invalid = new ConfigurationError("PLURNK_PROVIDERS_EFFORT", cause instanceof Error ? cause.message : String(cause), { cause });
            throw new OperationFailureError(Results.configurationFailure(invalid), { cause });
        }
    }

    // {§machine-processes} — provider inference is an exclusive capability of a
    // model session. The same assertion is used by early client admissions, the final
    // drain callback, and the model, reasoning, and spawn-model controls
    // ({§session-model-selection}), so recovery and internal callers cannot bypass it.
    async assertModelSession(workspaceId: number, sessionId: number): Promise<void> {
        const session = await this.#db.envelope_get_session_by_id.get<{
            workspace_id: number;
            origin: string;
        }>({ id: sessionId });
        if (session === undefined) {
            throw daemonFailure(
                "daemon:session",
                "session-not-found",
                404,
                `Session ${sessionId} does not exist.`,
                { sessionId },
            );
        }
        if (session.workspace_id !== workspaceId) {
            throw daemonFailure(
                "daemon:session",
                "workspace-mismatch",
                409,
                `Session ${sessionId} does not belong to workspace ${workspaceId}.`,
                {
                    sessionId,
                    workspaceId,
                    actualWorkspaceId: session.workspace_id,
                    retryable: false },
            );
        }
        if (session.origin !== "model") {
            throw daemonFailure(
                "daemon:session",
                "model-session-required",
                409,
                `Session ${sessionId} is not a model session.`,
                {
                    sessionId,
                    actualOrigin: session.origin,
                    recovery: "Select or create a model session.",
                    retryable: false },
            );
        }
    }

    // {§session-model-selection} — the loop's durable policy is resolved through model_routes
    // at each turn boundary; never re-resolved through the alias cascade (a changed alias
    // declaration must not rewrite history).
    async loopPolicy(loopId: number): Promise<LoopGenerationPolicy> {
        const row = await this.#db.drain_loop_generation_policy.get<SessionGenerationPolicyRow>({ loop_id: loopId });
        if (row === undefined) throw new Error(`loop ${loopId}: provider selection row is missing`);
        const providerSpec = await specForRoute(this.#db, row.model_route_id);
        if (providerSpec === null) {
            throw new Error(`loop ${loopId}: persisted provider selection is missing — refusing boot-default substitution`);
        }
        if (row.effort === null) {
            throw new Error(`loop ${loopId}: persisted effort is missing`);
        }
        return {
            providerSpec,
            childProviderSpec: await specForRoute(this.#db, row.spawn_model_route_id),
            effort: row.effort };
    }

    // The providers a claimed loop runs on, instantiated from its durable policy: the loop's own, and its spawn
    // model's or the same one.
    async providersForLoop(loopId: number): Promise<{ provider: Provider; childProvider: Provider }> {
        const policy = await this.loopPolicy(loopId);
        const provider = await this.providerForPolicy(policy.providerSpec, policy.effort);
        const childProvider = policy.childProviderSpec === null
            ? provider
            : await this.providerForPolicy(policy.childProviderSpec, policy.effort);
        return { provider, childProvider };
    }

    // {§session-model-selection} — project a session's durable model and spawn override
    // for a client-interface get/set surface. Ownership is checked at this boundary.
    async readSessionModel(args: { workspaceId: number; sessionId: number }): Promise<{ model: ModelRoute | null; spawnModel: ModelRoute | null }> {
        const workspaceId = ClientInput.assertId("session.model.get", "workspaceId", args.workspaceId);
        const sessionId = ClientInput.assertId("session.model.get", "sessionId", args.sessionId);
        await this.assertModelSession(workspaceId, sessionId);
        const row = await this.#db.session_generation_policy_read.get<SessionGenerationPolicyRow>({ id: sessionId });
        if (row === undefined) throw new Error(`session ${sessionId}: model route row missing`);
        const modelSpec = await specForRoute(this.#db, row.model_route_id);
        const spawnModelSpec = await specForRoute(this.#db, row.spawn_model_route_id);
        return {
            model: modelSpec === null ? null : projectModelRoute(modelSpec, row.effort, row.effort_source),
            spawnModel: spawnModelSpec === null ? null : projectModelRoute(spawnModelSpec, row.effort, row.effort_source) };
    }

    // {§session-model-selection} — persist an explicit model selection onto the session
    // and return the resolved spec. An unresolvable selector fails loud here.
    async setSessionModel(args: { workspaceId: number; sessionId: number; selector: string; effort?: unknown }): Promise<ModelRoute> {
        const workspaceId = ClientInput.assertId("session.model.set", "workspaceId", args.workspaceId);
        const sessionId = ClientInput.assertId("session.model.set", "sessionId", args.sessionId);
        await this.assertModelSession(workspaceId, sessionId);
        const selector = ClientInput.assertSelector("session.model.set", "selector", args.selector);
        let chosen: Effort | undefined;
        if (args.effort !== undefined) {
            try {
                chosen = Validator.assertEffort(args.effort);
            } catch (cause) {
                throw daemonFailure("daemon:input", "effort-invalid", 400,
                    cause instanceof Error ? cause.message : "The effort is invalid.", {
                        field: "effort",
                        recovery: `Select a valid effort: ${EFFORTS.join(", ")}.`,
                        retryable: false });
            }
        }
        const policy = await this.resolveSessionModel(sessionId, selector, chosen);
        if (policy === null) throw providerNotConfigured();
        return projectModelRoute(policy.providerSpec, policy.effort, policy.effortSource);
    }

    // {§session-model-selection} — the session's effort is durable and
    // provider-relative. A model-less session remains explicitly uninitialized.
    async readSessionEffort(args: {
        workspaceId: number;
        sessionId: number;
    }): Promise<{ effort: Effort | null; source: EffortSource; supportedEfforts: readonly Effort[] }> {
        const workspaceId = ClientInput.assertId("session.effort.get", "workspaceId", args.workspaceId);
        const sessionId = ClientInput.assertId("session.effort.get", "sessionId", args.sessionId);
        await this.assertModelSession(workspaceId, sessionId);
        await this.resolveSessionModel(sessionId, undefined);
        const row = await this.#db.session_generation_policy_read.get<SessionGenerationPolicyRow>({ id: sessionId });
        if (row === undefined) throw new Error(`session ${sessionId}: generation policy row missing`);
        if (row.model_route_id === null) {
            if (row.effort !== null) {
                throw new Error(`session ${sessionId}: effort exists without a model route`);
            }
            return { effort: null, source: "default", supportedEfforts: [] };
        }
        if (row.effort === null) {
            throw new Error(`session ${sessionId}: durable model has no effort`);
        }
        return {
            effort: row.effort,
            source: row.effort_source,
            supportedEfforts: await this.supportedEfforts(row) };
    }

    // {§session-model-selection} — validate against both the session model and its optional
    // spawn model, then persist atomically onto the session and any unfinished loops.
    async setSessionEffort(args: {
        workspaceId: number;
        sessionId: number;
        effort: unknown;
    }): Promise<{ effort: Effort; source: "explicit"; supportedEfforts: readonly Effort[] }> {
        const workspaceId = ClientInput.assertId("session.effort.set", "workspaceId", args.workspaceId);
        const sessionId = ClientInput.assertId("session.effort.set", "sessionId", args.sessionId);
        let effort: Effort;
        try {
            effort = Validator.assertEffort(args.effort);
        } catch (cause) {
            throw daemonFailure(
                "daemon:input",
                "effort-invalid",
                400,
                cause instanceof Error ? cause.message : "The effort is invalid.",
                {
                    field: "effort",
                    recovery: `Select a valid effort: ${EFFORTS.join(", ")}.`,
                    retryable: false,
                },
            );
        }
        await this.assertModelSession(workspaceId, sessionId);
        return this.#withPolicyLock(sessionId, async () => {
            // A model-less session takes the default first; an existing pair is replaced, not re-validated, so an
            // effort its model no longer supports can be corrected ({§session-model-selection}).
            const current = await this.#db.session_generation_policy_read.get<SessionGenerationPolicyRow>({ id: sessionId });
            if (current?.model_route_id === null) await this.#resolveModelUnlocked(sessionId, undefined);
            const row = await this.#db.session_generation_policy_read.get<SessionGenerationPolicyRow>({ id: sessionId });
            if (row === undefined) throw new Error(`session ${sessionId}: generation policy row missing`);
            const spec = await specForRoute(this.#db, row.model_route_id);
            if (spec === null) {
                throw daemonFailure(
                    "daemon:provider",
                    "session-model-unset",
                    409,
                    `Session ${sessionId} has no model against which to validate an effort.`,
                    {
                        sessionId,
                        stage: "provider-selection",
                        recovery: "Select a model before selecting its effort.",
                        retryable: false },
                );
            }
            const supportedEfforts = await this.#persistPolicy(sessionId, {
                model_route_id: row.model_route_id,
                spawn_model_route_id: row.spawn_model_route_id,
                effort,
                effort_source: "explicit" });
            return { effort, source: "explicit" as const, supportedEfforts };
        });
    }

    // {§session-model-selection} — persist the session's spawn override; a null
    // selector means inherit (clears the override).
    async setSessionSpawnModel(args: { workspaceId: number; sessionId: number; selector: string | null }): Promise<ModelRoute | null> {
        const workspaceId = ClientInput.assertId("session.child.set", "workspaceId", args.workspaceId);
        const sessionId = ClientInput.assertId("session.child.set", "sessionId", args.sessionId);
        await this.assertModelSession(workspaceId, sessionId);
        const selector = ClientInput.assertChildSelector("session.child.set", args.selector);
        const spec = await this.resolveSessionSpawnModel(sessionId, selector);
        if (spec === null) return null;
        const row = await this.#db.session_generation_policy_read.get<SessionGenerationPolicyRow>({ id: sessionId });
        return projectModelRoute(spec, row?.effort ?? null, row?.effort_source ?? "default");
    }

    listProviders(): ReturnType<ApplicationPort["listProviders"]> {
        const active = process.env.PLURNK_MODEL?.toLowerCase();
        let aliases;
        try { aliases = parseAliasesFromEnv(); }
        catch (cause) {
            if (!(cause instanceof ConfigurationError)) throw cause;
            throw new OperationFailureError(Results.configurationFailure(cause), { cause });
        }
        return {
            aliases: aliases.map((a) => {
                const isActive = active === a.alias;
                // {§acp-status-descendants} — the route a session seeded from this alias gets: what it would read back.
                const effort = this.#configuredEffort(a);
                return {
                    ...projectModelRoute(a, effort, "default"), alias: a.alias, active: isActive,
                    inputCapacity: isActive && this.#provider !== null ? this.#provider.inputCapacity : null };
            }) };
    }

    // {§session-model-selection} The catalog is a bounded, daemon-local projection.
    // It performs no provider I/O and never changes the session's selection.
    listModels(query: ModelCatalogQuery): ModelCatalogPage {
        return listModelCatalog(query);
    }
}
