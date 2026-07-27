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
    EntryStorageReadResult,
    EntryStorageWriteResult,
    FindStatement,
    ReadStatement,
    SchemeManifest,
    SchemeResult,
    SendStatement,
} from "@plurnk/plurnk-schemes";
import { Results } from "@plurnk/plurnk-schemes";
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

    #result<T extends { status: number; error?: string }>(
        operation: string,
        result: T,
    ): Omit<T, "error"> & SchemeResult {
        const { error, ...fields } = result;
        if (result.status >= 400) {
            return Results.failure(
                `scheme:${this.#scheme}`,
                `${operation}-failed`,
                result.status,
                error ?? `${operation.toUpperCase()} failed in scheme '${this.#scheme}' with status ${result.status}.`,
                fields,
            ) as Omit<T, "error"> & SchemeResult;
        }
        return Results.assert(fields as Omit<T, "error"> & SchemeResult);
    }

    async #editBatch(statements: readonly EditStatement[], owner?: EntryOwner): Promise<EntryEditResult> {
        return this.#result("edit", await EntryOps.editWorkspaceEntryBatch(statements, this.#ctx, this.#manifest, this.#ownerId(owner))) as EntryEditResult;
    }

    async #read(statement: ReadStatement, owner?: EntryOwner): Promise<EntryReadResult> {
        return this.#result("read", await EntryOps.readWorkspaceEntry(statement, this.#ctx, this.#manifest, this.#ownerId(owner))) as EntryReadResult;
    }

    async #find(statement: FindStatement, owner?: EntryOwner): Promise<EntryFindResult> {
        return this.#result("find", await EntryFind.findWorkspaceEntries(statement, this.#ctx, this.#manifest, this.#ownerId(owner))) as EntryFindResult;
    }

    async #send(statement: SendStatement, owner?: EntryOwner): Promise<SchemeResult> {
        return this.#result("send", await EntrySend.sendToWorkspaceEntry(statement, this.#ctx, this.#scheme, this.#ownerId(owner)));
    }

    async read(pathname: string, owner?: EntryOwner): Promise<EntryStorageReadResult> {
        return EntryCrud.readEntry(pathname, this.#ctx, this.#scheme, this.#ownerId(owner));
    }

    async write(pathname: string, entry: EntryData, owner?: EntryOwner): Promise<EntryStorageWriteResult> {
        // schemes' EntryData carries `tags` as ReadonlyArray; EntryCrud writes a
        // mutable array — copy at the boundary.
        return EntryCrud.writeEntry(pathname, { channels: entry.channels, tags: [...entry.tags] }, this.#ctx, this.#scheme, this.#ownerId(owner));
    }

    async delete(pathname: string, owner?: EntryOwner): Promise<SchemeResult> {
        return EntryCrud.deleteEntry(pathname, this.#ctx, this.#scheme, this.#ownerId(owner));
    }
}
