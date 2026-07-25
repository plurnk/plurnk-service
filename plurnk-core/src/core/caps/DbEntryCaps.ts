// Consumer implementation of the stable entry domain. Direct storage and
// standard PLURNK entry operations share the same proven core primitives.

import type {
    EditStatement,
    EntryCaps,
    EntryData,
    EntryEditResult,
    EntryFindResult,
    EntryOperationCaps,
    EntryOwner,
    EntryReadResult,
    FindStatement,
    ReadStatement,
    SchemeManifest,
    SchemeResult,
    SendStatement,
} from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import EntryCrud from "../../schemes/_entry-crud.ts";
import EntryFind from "../../schemes/_entry-find.ts";
import EntryOps from "../../schemes/_entry-ops.ts";
import EntrySend from "../../schemes/_entry-send.ts";

export default class DbEntryCaps implements EntryCaps {
    readonly #ctx: PlurnkSchemeContext;
    readonly #scheme: string;
    readonly #manifest: SchemeManifest;
    readonly operations: EntryOperationCaps;

    constructor(ctx: PlurnkSchemeContext, scheme: string, manifest: SchemeManifest) {
        this.#ctx = ctx;
        this.#scheme = scheme;
        // One handler may own multiple addressed protocols (http/https, ws/wss).
        // Every cap surface must operate in the identity the caller addressed:
        // direct CRUD already uses #scheme; standard operations derive identity
        // from manifest.name, so give them the same addressed face.
        this.#manifest = manifest.name === scheme ? manifest : { ...manifest, name: scheme };
        this.operations = {
            editBatch: (statements, owner) => this.#editBatch(statements, owner),
            read: (statement, owner) => this.#read(statement, owner),
            find: (statement, owner) => this.#find(statement, owner),
            send: (statement, owner) => this.#send(statement, owner),
        };
    }

    #ownerId(owner: EntryOwner | undefined): number | undefined {
        return owner === "worker" ? this.#ctx.workerId : undefined;
    }

    async #editBatch(statements: readonly EditStatement[], owner?: EntryOwner): Promise<EntryEditResult> {
        return { ...await EntryOps.editWorkspaceEntryBatch(statements, this.#ctx, this.#manifest, this.#ownerId(owner)) };
    }

    async #read(statement: ReadStatement, owner?: EntryOwner): Promise<EntryReadResult> {
        return { ...await EntryOps.readWorkspaceEntry(statement, this.#ctx, this.#manifest, this.#ownerId(owner)) };
    }

    async #find(statement: FindStatement, owner?: EntryOwner): Promise<EntryFindResult> {
        return { ...await EntryFind.findWorkspaceEntries(statement, this.#ctx, this.#manifest, this.#ownerId(owner)) };
    }

    async #send(statement: SendStatement, owner?: EntryOwner): Promise<SchemeResult> {
        return EntrySend.sendToWorkspaceEntry(statement, this.#ctx, this.#scheme, this.#ownerId(owner));
    }

    async read(pathname: string, owner?: EntryOwner): Promise<{ status: number; entry: EntryData | null }> {
        return EntryCrud.readEntry(pathname, this.#ctx, this.#scheme, this.#ownerId(owner));
    }

    async write(pathname: string, entry: EntryData, owner?: EntryOwner): Promise<{ status: number; created: boolean; entryId: number | null }> {
        // schemes' EntryData carries `tags` as ReadonlyArray; EntryCrud writes a
        // mutable array — copy at the boundary.
        return EntryCrud.writeEntry(pathname, { channels: entry.channels, tags: [...entry.tags] }, this.#ctx, this.#scheme, this.#ownerId(owner));
    }

    async delete(pathname: string, owner?: EntryOwner): Promise<{ status: number }> {
        return EntryCrud.deleteEntry(pathname, this.#ctx, this.#scheme, this.#ownerId(owner));
    }
}
