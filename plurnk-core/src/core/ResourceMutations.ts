import { type EditStatement, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import type ProposalLifecycle from "./ProposalLifecycle.ts";
import type { ProposalSettlement } from "./ProposalLifecycle.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "../schemes/_entry-crud.ts";
import type { WriterTier, PlurnkSchemeContext } from "./scheme-types.ts";
import type EntryAddressBinding from "./EntryAddressBinding.ts";
import type { BoundEntryAddress } from "./EntryAddressBinding.ts";
import type { DispatchResult, RunOperation, PrepareDataRepresentation, ProposalIds } from "./mutation-types.ts";
import MutationEffects from "./MutationEffects.ts";
import EditMutations from "./EditMutations.ts";
import ResourceSelector from "./ResourceSelector.ts";
import ResourceTransfers from "./ResourceTransfers.ts";

// Owns EDIT batch state and COPY/MOVE resource mutation composition.
// Dispatcher retains admission, generic scheme routing, proposal lifecycle, and durable operation recording.
export default class ResourceMutations {
    readonly #edits: EditMutations;
    readonly #selection: ResourceSelector;
    readonly #transfers: ResourceTransfers;

    constructor({
        schemes,
        liveSubscriptions,
        run,
        checkWritable,
        checkCapabilities,
        editTargetIdentity,
        canonicalFilePath,
        prepareDataRepresentation,
        resolveDataEntryAddress,
        readEntry,
        writeEntry,
        deleteChannel,
        applyProposal,
    }: {
        schemes: SchemeRegistry;
        liveSubscriptions: LiveSubscriptions;
        run: RunOperation;
        checkWritable: (statement: PlurnkStatement, origin: WriterTier, workerId: number) => DispatchResult | null;
        checkCapabilities: (statement: PlurnkStatement, workspaceId: number, loopId: number, workerId: number) => Promise<DispatchResult | null>;
        editTargetIdentity: (
            statement: EditStatement,
            workspaceId: number,
            workerId: number,
        ) => Promise<{ readonly key: string; readonly identity: string | null }>;
        canonicalFilePath: (pathname: string, workspaceId: number) => Promise<string | null>;
        prepareDataRepresentation: PrepareDataRepresentation;
        resolveDataEntryAddress: EntryAddressBinding["resolve"];
        readEntry: (scheme: string, address: BoundEntryAddress, ctx: PlurnkSchemeContext) => Promise<ReadEntryResult>;
        writeEntry: (scheme: string, address: BoundEntryAddress, entry: EntryData, ctx: PlurnkSchemeContext) => Promise<WriteEntryResult>;
        deleteChannel: (
            scheme: string,
            address: BoundEntryAddress,
            channel: string,
            ctx: PlurnkSchemeContext,
        ) => Promise<DeleteEntryResult>;
        applyProposal: ProposalLifecycle["workerApply"];
    }) {
        this.#selection = new ResourceSelector({ schemes, canonicalFilePath, prepareDataRepresentation });
        this.#edits = new EditMutations({ schemes, liveSubscriptions, run, checkWritable, checkCapabilities, editTargetIdentity, resolveDataEntryAddress });
        this.#transfers = new ResourceTransfers({ schemes, liveSubscriptions, resolveDataEntryAddress, readEntry, writeEntry, deleteChannel, applyProposal, selection: this.#selection });
    }

    async prepareEditBatches(...args: Parameters<EditMutations["prepareEditBatches"]>): ReturnType<EditMutations["prepareEditBatches"]> {
        return this.#edits.prepareEditBatches(...args);
    }

    preparedEditResult(...args: Parameters<EditMutations["preparedEditResult"]>): ReturnType<EditMutations["preparedEditResult"]> {
        return this.#edits.preparedEditResult(...args);
    }

    withMergeFacts(...args: Parameters<EditMutations["withMergeFacts"]>): ReturnType<EditMutations["withMergeFacts"]> {
        return this.#edits.withMergeFacts(...args);
    }

    settleEdit(...args: Parameters<EditMutations["settleEdit"]>): ReturnType<EditMutations["settleEdit"]> {
        return this.#edits.settleEdit(...args);
    }

    async handleCopy(...args: Parameters<ResourceTransfers["handleCopy"]>): ReturnType<ResourceTransfers["handleCopy"]> {
        return this.#transfers.handleCopy(...args);
    }

    async handleMove(...args: Parameters<ResourceTransfers["handleMove"]>): ReturnType<ResourceTransfers["handleMove"]> {
        return this.#transfers.handleMove(...args);
    }

    async settleProposal({
        statement,
        result,
        settlement,
        ctx,
        ids,
    }: {
        statement: PlurnkStatement;
        result: DispatchResult;
        settlement: ProposalSettlement;
        ctx: PlurnkSchemeContext;
        ids: ProposalIds;
    }): Promise<ProposalSettlement> {
        const withEffects = MutationEffects.settleProposalEffects(result, settlement);
        const settledMove = await this.#transfers.settleMoveProposal({
            statement,
            result,
            settlement: withEffects,
            ctx,
            ids,
        });
        // {§edit-batch-merges} — the applied result is what the row records; the statement's
        // merge facts ride it here, whichever route settled the proposal.
        const editStatement = statement.op === "EDIT" ? statement : null;
        const facts = editStatement === null ? [] : (this.#edits.mergeFacts(editStatement));
        const effective: ProposalSettlement = editStatement === null || facts.length === 0
            ? settledMove
            : {
                ...settledMove,
                ...(settledMove.applied === undefined ? {} : { applied: this.withMergeFacts(editStatement, settledMove.applied) }),
                // The accepted row is composed from resolution.result ({§proposal-projection}).
                resolution: { ...settledMove.resolution, result: { ...(settledMove.resolution.result ?? {}), merged: facts } },
            };
        this.#edits.recordEditSettlement(statement, effective);
        return effective;
    }
}
