// Consumer implementation of the stable entry domain. Direct storage and
// standard PLURNK entry operations share the same proven core primitives.

import type {
    EntryCaps,
    EntryData,
    EntryEditResult,
    EntryFindResult,
    EntryOperationCaps,
    EntryStorageReadResult,
    EntryStorageWriteResult,
    FindStatement,
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
import { renderAddress } from "../plurnk-uri.ts";

export default class DbEntryCaps implements EntryCaps {
    readonly #ctx: PlurnkSchemeContext;
    readonly #scheme: string;
    readonly #authority: string;
    readonly #manifest: SchemeManifest;
    readonly #editPrecondition: LineAnchorPrecondition | null;
    readonly operations: EntryOperationCaps;

    constructor(
        ctx: PlurnkSchemeContext,
        scheme: string,
        manifest: SchemeManifest,
        authority: string,
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
        this.#editPrecondition = editPrecondition;
        this.operations = {
            editBatch: (statements) => this.#editBatch(statements),
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
            this.#editPrecondition,
        )) as EntryEditResult;
    }

    async #find(statement: FindStatement): Promise<EntryFindResult> {
        return this.#result("find", await EntryFind.findWorkspaceEntries(statement, this.#ctx, this.#manifest, {
            authority: this.#authority,
        })) as EntryFindResult;
    }

    async #send(statement: SendStatement): Promise<SchemeResult> {
        return this.#result("send", await EntrySend.sendToWorkspaceEntry(statement, this.#ctx, this.#manifest));
    }

    async read(pathname: string): Promise<EntryStorageReadResult> {
        return EntryCrud.readEntry({ authority: this.#authority, pathname }, this.#ctx, this.#scheme);
    }

    async address(pathname: string): Promise<string> {
        return renderAddress({ scheme: this.#scheme, authority: this.#authority, pathname });
    }

    async write(pathname: string, entry: EntryData): Promise<EntryStorageWriteResult> {
        return EntryCrud.writeEntry({ authority: this.#authority, pathname }, {
            channels: entry.channels,
            ...(entry.attributes === undefined ? {} : { attributes: entry.attributes }),
        }, this.#ctx, this.#scheme);
    }

    async delete(pathname: string, channel?: string): Promise<SchemeResult> {
        return channel === undefined
            ? EntryCrud.deleteEntry({ authority: this.#authority, pathname }, this.#ctx, this.#scheme)
            : EntryCrud.deleteChannel({ authority: this.#authority, pathname }, channel, this.#ctx, this.#scheme);
    }
}
