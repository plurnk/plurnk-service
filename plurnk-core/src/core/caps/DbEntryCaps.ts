// Consumer implementation of the stable entry domain. Direct storage and
// standard PLURNK entry operations share the same proven core primitives.

import type {
    EntryCaps,
    EntryData,
    EntryEditResult,
    EntryFindResult,
    EntryOperationCaps,
    EntryReadResult,
    EntryStorageReadResult,
    EntryStorageWriteResult,
    FindStatement,
    ReadStatement,
    ResolvedEditStatement,
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
import type { LineAnchorPrecondition } from "../../content/index.ts";

export default class DbEntryCaps implements EntryCaps {
    readonly #ctx: PlurnkSchemeContext;
    readonly #scheme: string;
    readonly #authority: string;
    readonly #manifest: SchemeManifest;
    readonly #ownerId: number;
    readonly #editPrecondition: LineAnchorPrecondition | null;
    readonly operations: EntryOperationCaps;

    constructor(
        ctx: PlurnkSchemeContext,
        scheme: string,
        manifest: SchemeManifest,
        authority: string,
        ownerId: number,
        editPrecondition: LineAnchorPrecondition | null = null,
    ) {
        this.#ctx = ctx;
        this.#scheme = scheme;
        this.#authority = authority;
        // One handler may own multiple addressed protocols (http/https, ws/wss).
        // Every cap surface must operate in the identity the caller addressed:
        // direct CRUD already uses #scheme; standard operations derive identity
        // from manifest.name, so give them the same addressed face.
        this.#manifest = manifest.name === scheme ? manifest : { ...manifest, name: scheme };
        this.#ownerId = ownerId;
        this.#editPrecondition = editPrecondition;
        this.operations = {
            editBatch: (statements) => this.#editBatch(statements),
            read: (statement) => this.#read(statement),
            find: (statement) => this.#find(statement),
            send: (statement) => this.#send(statement),
        };
    }

    #result<T extends SchemeResult>(operation: string, result: T): T {
        if (Results.isErrorStatus(result.status) && result.problem === undefined) {
            throw new Error(`DbEntryCaps.${operation}: failed operation omitted Problem Details`);
        }
        return Results.assert(result);
    }

    async #editBatch(statements: readonly ResolvedEditStatement[]): Promise<EntryEditResult> {
        return this.#result("edit", await EntryOps.editWorkspaceEntryBatch(
            statements,
            this.#ctx,
            this.#manifest,
            this.#ownerId,
            this.#editPrecondition,
        )) as EntryEditResult;
    }

    async #read(statement: ReadStatement): Promise<EntryReadResult> {
        return this.#result("read", await EntryOps.readWorkspaceEntry(statement, this.#ctx, this.#manifest, {
            ownerId: this.#ownerId,
            authority: this.#authority,
        })) as EntryReadResult;
    }

    async #find(statement: FindStatement): Promise<EntryFindResult> {
        return this.#result("find", await EntryFind.findWorkspaceEntries(statement, this.#ctx, this.#manifest, {
            ownerId: this.#ownerId,
            authority: this.#authority,
        })) as EntryFindResult;
    }

    async #send(statement: SendStatement): Promise<SchemeResult> {
        return this.#result("send", await EntrySend.sendToWorkspaceEntry(statement, this.#ctx, this.#manifest, this.#ownerId));
    }

    async read(pathname: string): Promise<EntryStorageReadResult> {
        return EntryCrud.readEntry({ authority: this.#authority, pathname }, this.#ctx, this.#scheme, this.#ownerId);
    }

    async write(pathname: string, entry: EntryData): Promise<EntryStorageWriteResult> {
        return EntryCrud.writeEntry({ authority: this.#authority, pathname }, {
            channels: entry.channels,
            ...(entry.attributes === undefined ? {} : { attributes: entry.attributes }),
        }, this.#ctx, this.#scheme, this.#ownerId);
    }

    async delete(pathname: string, channel?: string): Promise<SchemeResult> {
        return channel === undefined
            ? EntryCrud.deleteEntry({ authority: this.#authority, pathname }, this.#ctx, this.#scheme, this.#ownerId)
            : EntryCrud.deleteChannel({ authority: this.#authority, pathname }, channel, this.#ctx, this.#scheme, this.#ownerId);
    }
}
