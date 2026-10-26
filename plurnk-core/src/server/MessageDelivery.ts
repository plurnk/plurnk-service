// A message's delivery to a worker: the seam's runLoop and the worker scheme's injectWorker both resolve the worker's
// model and effort, read the card, prepare the message with its attachments, attribute its source, and inject it into
// the worker's drain, which starts a loop or folds into the active one. Split out of Daemon, which keeps the drain's
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
import WorkerControlAddress from "../core/WorkerControlAddress.ts";
import ClientInput from "./client-input.ts";
import type { DrainInjectionArgs, DrainInjectionResult, TurnCeilingSelection } from "./DrainSupervisor.ts";
import { routeForSpec } from "./model-route.ts";
import { type default as WorkerModels, providerNotConfigured } from "./WorkerModels.ts";

type EngineCallbacks = ConstructorParameters<typeof Engine>[0];
type InjectWorker = NonNullable<EngineCallbacks["injectWorker"]>;
type InjectWorkerArgs = Parameters<InjectWorker>[0];
type InjectWorkerResult = Awaited<ReturnType<InjectWorker>>;

export default class MessageDelivery {
    readonly #db: Db;
    readonly #workerModels: WorkerModels;
    readonly #mimetypes: Mimetypes;
    // The drain's unified inject: active sister → fold; idle → enqueue + drain ({§machine-processes}).
    readonly #inject: (args: DrainInjectionArgs) => Promise<DrainInjectionResult>;

    constructor({ db, workerModels, mimetypes, inject }: {
        db: Db;
        workerModels: WorkerModels;
        mimetypes: Mimetypes;
        inject: (args: DrainInjectionArgs) => Promise<DrainInjectionResult>;
    }) {
        this.#db = db;
        this.#workerModels = workerModels;
        this.#mimetypes = mimetypes;
        this.#inject = inject;
    }

    // {§methods-loop-run} — drive/steer a loop. The module supplies only workspace/worker/prompt;
    // the provider and the law-file system prompt are core's and stay inside. Returns immediately — the
    // loop runs async and its outcome arrives on the event source (loop/terminated). `cancelDrain` (public)
    // is the cancel hook. Both funnel through the unified `inject`, which owns the drain lifecycle.
    async runLoop(args: { workspaceId: number; workerId: number; loopId?: number; prompt: string; source?: string; messageAddress?: string; attachments?: readonly MessageResource[]; envelope?: Readonly<Record<string, unknown>>; maxTurns?: number; openPaths?: string[]; selector?: string; childSelector?: string | null }): Promise<SchemeResult & { action: "injected_next_turn" | "enqueued_new_loop"; loopId: number; turnSeq?: number }> {
        const workspaceId = ClientInput.assertId("runLoop", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("runLoop", "workerId", args.workerId);
        const recipientLoopId = args.loopId === undefined ? undefined : ClientInput.assertId("runLoop", "loopId", args.loopId);
        await this.#workerModels.assertModelWorker(workspaceId, workerId);
        const attachments = ClientInput.assertMessageResources("runLoop", args.attachments);
        const body = ClientInput.assertPrompt("runLoop", args.prompt, attachments.length > 0);
        const source = ClientInput.assertOptionalSource("runLoop", args.source);
        const messageAddress = ClientInput.assertOptionalSource("runLoop", args.messageAddress);
        const requestedMaxTurns = ClientInput.assertMaxTurns("runLoop", args.maxTurns);
        const openPaths = ClientInput.assertOpenPaths("runLoop", args.openPaths);
        const selector = ClientInput.assertOptionalSelector("runLoop", "selector", args.selector);
        const childSelector = ClientInput.assertOptionalChildSelector("runLoop", args.childSelector);
        // {§worker-model-selection} — the worker owns the model. An explicit selector
        // persists onto the worker; an omitted selector resolves the worker's durable model
        // (seeded once from the daemon default). The loop then snapshots the resolved route.
        // A continuation's omitted selector must still keep the loop's durable provider.
        const selectorExplicit = selector !== undefined;
        const generationPolicy = await this.#workerModels.resolveWorkerModel(workerId, selector);
        if (generationPolicy === null) throw providerNotConfigured();
        const { providerSpec: selection, effort } = generationPolicy;
        // {§methods-loop-run-child-provider} — the worker's persistent spawn override.
        const childSelection = await this.#workerModels.resolveWorkerSpawnModel(workerId, childSelector);
        const systemPrompt = await readFile(Paths.instructionsSystem, "utf8"); // {§card-read-per-wake}
        // {§operator-config-max-turns-ceiling} — the operator ceiling clamps a per-call maxTurns; a
        // seam caller must not bypass operator policy (inject only DEFAULTS from env, never clamps).
        const ceiling = Knob.integer("PLURNK_SERVICE_MAX_TURNS", -1);
        const requested = requestedMaxTurns ?? ceiling;
        const maxTurns = ceiling < 0 ? requested : (requested < 0 ? ceiling : Math.min(requested, ceiling));
        const turnCeiling: TurnCeilingSelection = {
            effective: maxTurns,
            source: requestedMaxTurns === undefined ? "implicit" : "explicit" };
        const { action, loopId, turnSeq } = await ContentUse.read(this.#db, async () => {
            const delivered = await this.#prepareMessage(workspaceId, workerId, body, attachments, args.envelope);
            return this.#inject({
                workspaceId,
                workerId,
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

    // worker:// loop-start primitive — spawn/fork/irc deliver through the drain's inject (active sister → fold; idle →
    // enqueue + drain). The daemon owns provider + the law-file system prompt; the worker scheme handler carries
    // neither. Fire-and-forget: the returned drain runs independently (the sister is its own worker).
    // {§machine-processes}
    async injectWorker({ workspaceId, workerId, sourceLoopId, prompt, spawn, attachments, opener }: InjectWorkerArgs): Promise<InjectWorkerResult> {
        await this.#workerModels.assertModelWorker(workspaceId, workerId);
        const sender = await this.#db.drain_message_source.get<{ worker_id: number; workspace_id: number }>({ loop_id: sourceLoopId });
        if (sender === undefined || sender.workspace_id !== workspaceId) {
            throw new Error(`injectWorker: source loop ${sourceLoopId} does not belong to workspace ${workspaceId}`);
        }
        const source = await this.#messageSource(workspaceId, sourceLoopId, sender.worker_id, workerId);
        const systemPrompt = await readFile(Paths.instructionsSystem, "utf8"); // {§card-read-per-wake}
        let providerSpec: ProviderSpec;
        let childProviderSpec: ProviderSpec | null;
        let effort: Effort;
        if (spawn !== true) {
            // {§worker-model-selection} — the voice door addresses an
            // existing worker. Its own durable generation policy is the
            // receiver's identity; the daemon default and sender do not
            // overwrite it merely because a new loop must be minted.
            const targetPolicy = await this.#workerModels.resolveWorkerModel(workerId, undefined);
            if (targetPolicy === null) {
                throw new Error(`injectWorker: worker ${workerId} has no resolvable model route`);
            }
            providerSpec = targetPolicy.providerSpec;
            effort = targetPolicy.effort;
            childProviderSpec = await this.#workerModels.resolveWorkerSpawnModel(workerId, undefined);
        } else {
            const parentPolicy = await this.#workerModels.loopPolicy(sourceLoopId);
            providerSpec = parentPolicy.childProviderSpec ?? parentPolicy.providerSpec;
            effort = parentPolicy.effort;
            // {§worker-model-selection} — lineage inheritance by value:
            // the child begins with the spawning loop's effective spawn
            // model and no separate override of its own.
            childProviderSpec = null;
            // {§worker-effort-source} — inherited by value, chosen by nobody on this worker.
            await this.#workerModels.persistGenerationPolicy(workerId, {
                model_route_id: await routeForSpec(this.#db, providerSpec),
                spawn_model_route_id: null,
                effort: effort,
                effort_source: "default" }, { spawn: true });
        }
        const { action, loopId, messageId } = await ContentUse.read(this.#db, async () => {
            const delivered = await this.#prepareMessage(workspaceId, workerId, prompt, attachments);
            return this.#inject({
                workspaceId,
                workerId,
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
        // {§worker-obligations} — the message's durable address, as Open Work names it.
        const message = await this.#db.drain_message_path.get<{ path: string }>({ id: messageId });
        if (message === undefined) throw new Error(`injectWorker: message ${messageId} has no address`);
        return { action, loopId, message: message.path };
    }

    async #prepareMessage(workspaceId: number, workerId: number, body: string, attachments: readonly MessageResource[] = [], envelope?: Readonly<Record<string, unknown>>): Promise<{ body: string; evidence: MessageEvidence }> {
        const published = await MessageResources.publish(body, attachments, {
            db: this.#db, workspaceId, workerId, loopId: 0, turnId: 0, writer: "_plurnk", signal: undefined,
            weigh: contentWeight, mimetypes: this.#mimetypes,
        });
        return { body: published.body, evidence: {
            ...(envelope === undefined ? {} : { envelope: structuredClone(envelope) }),
            ...(published.attachments.length === 0 ? {} : { attachments: published.attachments }),
        } };
    }

    // {§actor-boundary-client-operations} A message speaks for its loop's actor: a person's operation for that
    // person, as a thread message does; any other loop for its worker.
    async #messageSource(
        workspaceId: number,
        sourceLoopId: number,
        sourceWorkerId: number,
        targetWorkerId: number,
    ): Promise<string | undefined> {
        const person = await this.#db.envelope_client_operation_person.get<{ person: string }>({ loop_id: sourceLoopId });
        if (person !== undefined) return person.person;
        if (sourceWorkerId === targetWorkerId) return undefined;
        const source = await this.#db.envelope_get_worker_by_id.get<{
            workspace_id: number;
            name: string;
        }>({ id: sourceWorkerId });
        if (source === undefined || source.workspace_id !== workspaceId) {
            throw new Error(
                `Worker prompt source ${sourceWorkerId} does not belong to workspace ${workspaceId}.`,
            );
        }
        return WorkerControlAddress.render(source.name);
    }
}
