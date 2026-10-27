// A message's delivery to a session: the seam's runLoop and the session scheme's injectSession both resolve the session's
// model and effort, read the card, prepare the message with its attachments, attribute its source, and inject it into
// the session's drain, which starts a loop or folds into the active one. Split out of Daemon, which keeps the drain's
// run callback and the delegating port entry point.
import { readFile } from "node:fs/promises";
import { type Effort, type MessageEvidence, type MessageResource } from "@plurnk/plurnk-contracts";
import { Knob } from "@plurnk/plurnk-meta";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { ProviderSpec } from "@plurnk/plurnk-providers";
import Paths from "../Paths.ts";
import { contentWeight } from "../core/content-weight.ts";
import ContentUse from "../core/ContentUse.ts";
import type { Db } from "../core/Db.ts";
import type Engine from "../core/Engine.ts";
import MessageResources from "../core/MessageResources.ts";
import type { SchemeResult } from "../core/results.ts";
import SessionControlAddress from "../core/SessionControlAddress.ts";
import ClientInput from "./client-input.ts";
import type { DrainInjectionArgs, DrainInjectionResult, TurnCeilingSelection } from "./DrainSupervisor.ts";
import { routeForSpec } from "./model-route.ts";
import { type default as SessionModels, providerNotConfigured } from "./SessionModels.ts";

type EngineCallbacks = ConstructorParameters<typeof Engine>[0];
type InjectSession = NonNullable<EngineCallbacks["injectSession"]>;
type InjectSessionArgs = Parameters<InjectSession>[0];
type InjectSessionResult = Awaited<ReturnType<InjectSession>>;

export default class MessageDelivery {
    readonly #db: Db;
    readonly #sessionModels: SessionModels;
    readonly #mimetypes: Mimetypes;
    // The drain's unified inject: active sister → fold; idle → enqueue + drain ({§machine-processes}).
    readonly #inject: (args: DrainInjectionArgs) => Promise<DrainInjectionResult>;

    constructor({ db, sessionModels, mimetypes, inject }: {
        db: Db;
        sessionModels: SessionModels;
        mimetypes: Mimetypes;
        inject: (args: DrainInjectionArgs) => Promise<DrainInjectionResult>;
    }) {
        this.#db = db;
        this.#sessionModels = sessionModels;
        this.#mimetypes = mimetypes;
        this.#inject = inject;
    }

    // {§methods-loop-run} — drive/steer a loop. The module supplies only workspace/session/prompt;
    // the provider and the law-file system prompt are core's and stay inside. Returns immediately — the
    // loop runs async and its outcome arrives on the event source (loop/terminated). `cancelDrain` (public)
    // is the cancel hook. Both funnel through the unified `inject`, which owns the drain lifecycle.
    async runLoop(args: { workspaceId: number; sessionId: number; loopId?: number; prompt: string; source?: string; messageAddress?: string; attachments?: readonly MessageResource[]; envelope?: Readonly<Record<string, unknown>>; maxTurns?: number; openPaths?: string[]; selector?: string; childSelector?: string | null }): Promise<SchemeResult & { action: "injected_next_turn" | "enqueued_new_loop"; loopId: number; turnSeq?: number }> {
        const workspaceId = ClientInput.assertId("runLoop", "workspaceId", args.workspaceId);
        const sessionId = ClientInput.assertId("runLoop", "sessionId", args.sessionId);
        const recipientLoopId = args.loopId === undefined ? undefined : ClientInput.assertId("runLoop", "loopId", args.loopId);
        await this.#sessionModels.assertModelSession(workspaceId, sessionId);
        const attachments = ClientInput.assertMessageResources("runLoop", args.attachments);
        const body = ClientInput.assertPrompt("runLoop", args.prompt, attachments.length > 0);
        const source = ClientInput.assertOptionalSource("runLoop", args.source);
        const messageAddress = ClientInput.assertOptionalSource("runLoop", args.messageAddress);
        const requestedMaxTurns = ClientInput.assertMaxTurns("runLoop", args.maxTurns);
        const openPaths = ClientInput.assertOpenPaths("runLoop", args.openPaths);
        const selector = ClientInput.assertOptionalSelector("runLoop", "selector", args.selector);
        const childSelector = ClientInput.assertOptionalChildSelector("runLoop", args.childSelector);
        // {§session-model-selection} — the session owns the model. An explicit selector
        // persists onto the session; an omitted selector resolves the session's durable model
        // (seeded once from the daemon default). The loop then snapshots the resolved route.
        // A continuation's omitted selector must still keep the loop's durable provider.
        const selectorExplicit = selector !== undefined;
        const generationPolicy = await this.#sessionModels.resolveSessionModel(sessionId, selector);
        if (generationPolicy === null) throw providerNotConfigured();
        const { providerSpec: selection, effort } = generationPolicy;
        // {§methods-loop-run-child-provider} — the session's persistent spawn override.
        const childSelection = await this.#sessionModels.resolveSessionSpawnModel(sessionId, childSelector);
        const systemPrompt = await readFile(Paths.instructionsSystem, "utf8"); // {§card-read-per-wake}
        // {§operator-config-workspace-settings} — the operator ceiling clamps a per-call maxTurns; a
        // seam caller must not bypass operator policy (inject only DEFAULTS from env, never clamps).
        const ceiling = Knob.integer("PLURNK_SERVICE_MAX_TURNS", -1);
        const requested = requestedMaxTurns ?? ceiling;
        const maxTurns = ceiling < 0 ? requested : (requested < 0 ? ceiling : Math.min(requested, ceiling));
        const turnCeiling: TurnCeilingSelection = {
            effective: maxTurns,
            source: requestedMaxTurns === undefined ? "implicit" : "explicit" };
        const { action, loopId, turnSeq } = await ContentUse.read(this.#db, async () => {
            const delivered = await this.#prepareMessage(workspaceId, sessionId, body, attachments, args.envelope);
            return this.#inject({
                workspaceId,
                sessionId,
                prompt: delivered.body,
                ...(recipientLoopId === undefined ? {} : { loopId: recipientLoopId }),
                evidence: delivered.evidence,
                ...(messageAddress === undefined ? {} : { messageAddress }),
                ...(source === undefined ? {} : { source }),
                ...(openPaths !== undefined ? { openPaths } : {}),
                turnCeiling,
                providerSpec: selection,
                providerSpecExplicit: selectorExplicit,
                effort,
                childProviderSpec: childSelection,
                systemPrompt });
        });
        return { status: 100, action, loopId, ...(turnSeq !== undefined ? { turnSeq } : {}) };
    }

    // session:// loop-start primitive — spawn/fork/irc deliver through the drain's inject (active sister → fold; idle →
    // enqueue + drain). The daemon owns provider + the law-file system prompt; the session scheme handler carries
    // neither. Fire-and-forget: the returned drain runs independently (the sister is its own session).
    // {§machine-processes}
    async injectSession({ workspaceId, sessionId, sourceLoopId, prompt, spawn, attachments, opener }: InjectSessionArgs): Promise<InjectSessionResult> {
        await this.#sessionModels.assertModelSession(workspaceId, sessionId);
        const sender = await this.#db.drain_message_source.get<{ session_id: number; workspace_id: number }>({ loop_id: sourceLoopId });
        if (sender === undefined || sender.workspace_id !== workspaceId) {
            throw new Error(`injectSession: source loop ${sourceLoopId} does not belong to workspace ${workspaceId}`);
        }
        const source = await this.#messageSource(workspaceId, sourceLoopId, sender.session_id, sessionId);
        const systemPrompt = await readFile(Paths.instructionsSystem, "utf8"); // {§card-read-per-wake}
        let providerSpec: ProviderSpec;
        let childProviderSpec: ProviderSpec | null;
        let effort: Effort;
        if (spawn !== true) {
            // {§session-model-selection} — the voice door addresses an
            // existing session. Its own durable generation policy is the
            // receiver's identity; the daemon default and sender do not
            // overwrite it merely because a new loop must be minted.
            const targetPolicy = await this.#sessionModels.resolveSessionModel(sessionId, undefined);
            if (targetPolicy === null) {
                throw new Error(`injectSession: session ${sessionId} has no resolvable model route`);
            }
            providerSpec = targetPolicy.providerSpec;
            effort = targetPolicy.effort;
            childProviderSpec = await this.#sessionModels.resolveSessionSpawnModel(sessionId, undefined);
        } else {
            const parentPolicy = await this.#sessionModels.loopPolicy(sourceLoopId);
            providerSpec = parentPolicy.childProviderSpec ?? parentPolicy.providerSpec;
            effort = parentPolicy.effort;
            // {§session-model-selection} — lineage inheritance by value:
            // the child begins with the spawning loop's effective spawn
            // model and no separate override of its own.
            childProviderSpec = null;
            // {§session-effort-source} — inherited by value, chosen by nobody on this session.
            await this.#sessionModels.persistGenerationPolicy(sessionId, {
                model_route_id: await routeForSpec(this.#db, providerSpec),
                spawn_model_route_id: null,
                effort: effort,
                effort_source: "default" }, { spawn: true });
        }
        const { action, loopId, messageId } = await ContentUse.read(this.#db, async () => {
            const delivered = await this.#prepareMessage(workspaceId, sessionId, prompt, attachments);
            return this.#inject({
                workspaceId,
                sessionId,
                prompt: delivered.body,
                evidence: delivered.evidence,
                sourceLoopId,
                ...(source === undefined ? {} : { source }),
                ...(opener === undefined ? {} : { opener }),
                providerSpec,
                effort,
                childProviderSpec,
                systemPrompt });
        });
        // {§loop-completion} — the message's durable address, as Open Work names it.
        const message = await this.#db.drain_message_path.get<{ path: string }>({ id: messageId });
        if (message === undefined) throw new Error(`injectSession: message ${messageId} has no address`);
        return { action, loopId, message: message.path };
    }

    async #prepareMessage(workspaceId: number, sessionId: number, body: string, attachments: readonly MessageResource[] = [], envelope?: Readonly<Record<string, unknown>>): Promise<{ body: string; evidence: MessageEvidence }> {
        const published = await MessageResources.publish(body, attachments, {
            db: this.#db, workspaceId, sessionId, loopId: 0, turnId: 0, writer: "_plurnk", signal: undefined,
            weigh: contentWeight, mimetypes: this.#mimetypes,
        });
        return { body: published.body, evidence: {
            ...(envelope === undefined ? {} : { envelope: structuredClone(envelope) }),
            ...(published.attachments.length === 0 ? {} : { attachments: published.attachments }),
        } };
    }

    // {§actor-boundary-client-operations} A message speaks for its loop's actor: a person's operation for that
    // person, as a thread message does; any other loop for its session.
    async #messageSource(
        workspaceId: number,
        sourceLoopId: number,
        sourceSessionId: number,
        targetSessionId: number,
    ): Promise<string | undefined> {
        const person = await this.#db.envelope_client_operation_person.get<{ person: string }>({ loop_id: sourceLoopId });
        if (person !== undefined) return person.person;
        if (sourceSessionId === targetSessionId) return undefined;
        const source = await this.#db.envelope_get_session_by_id.get<{
            workspace_id: number;
            name: string;
        }>({ id: sourceSessionId });
        if (source === undefined || source.workspace_id !== workspaceId) {
            throw new Error(
                `Session prompt source ${sourceSessionId} does not belong to workspace ${workspaceId}.`,
            );
        }
        return SessionControlAddress.render(source.name);
    }
}
