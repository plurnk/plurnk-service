// Shared SEND dispatcher for entry-bearing schemes. Schemes interpret
// status codes per SPEC {§send-dispatch}. v0 handles 410 (Gone, delete the resource)
// and 499 (Client Closed Request, cancel active subscription).

import type { SendStatement } from "@plurnk/plurnk-contracts";
import { entryCoordinateOf, renderAddress } from "../core/plurnk-uri.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import EntryCrud from "./_entry-crud.ts";
import ChannelWrite from "../core/ChannelWrite.ts";
import Results, { type SchemeResult } from "../core/results.ts";

export interface SendResult extends SchemeResult {}

export default class EntrySend {
    static #coordinateOf(statement: SendStatement, manifest: SchemeManifest): { authority: string; pathname: string } | null {
        const path = statement.target;
        if (path === null) return null;
        return entryCoordinateOf(path, manifest.authority ?? "namespace");
    }

    static #fragmentOf(statement: SendStatement): string | null {
        const path = statement.target;
        if (path === null || path.kind !== "url") return null;
        return path.fragment;
    }

    static async sendToWorkspaceEntry(statement: SendStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest, ownerId: number): Promise<SendResult> {
        const scheme = manifest.storedScheme ?? manifest.name;
        const failure = (
            code: string,
            status: number,
            detail: string,
            fields: Readonly<Record<string, unknown>> = {},
            extensions: Readonly<Record<string, unknown>> = {},
        ): SendResult => Results.failure(`scheme:${scheme}`, code, status, detail, fields, extensions);
        if (statement.target === null) {
            return failure(
                "target-required",
                400,
                "Directed SEND requires a target path.",
                {},
                {
                    recovery: "Provide the target path.",
                    retryable: false,
                },
            );
        }

        const status = statement.signal;
        if (status === null) {
            return failure(
                "status-required",
                400,
                "SEND requires a numeric status code.",
                {},
                {
                    recovery: "Provide a numeric SEND status.",
                    retryable: false,
                },
            );
        }

        // SEND signal 410 Gone — delete the targeted resource (SPEC {§send-dispatch}). With a
        // #fragment, deletes just that channel; without, deletes the whole entry.
        if (status === 410) {
            const coordinate = EntrySend.#coordinateOf(statement, manifest);
            if (coordinate === null) return failure("target-required", 400, "`## SEND0 [410]` requires a target path.");
            const { authority, pathname } = coordinate;
            const target = renderAddress({ scheme, authority, pathname });
            const fragment = EntrySend.#fragmentOf(statement);
            if (fragment !== null) {
                const { db, workspaceId } = ctx;
                const entry = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: ownerId, scheme, authority, pathname });
                if (entry === undefined) {
                    return failure(
                        "entry-not-found",
                        404,
                        `No entry exists at ${target}.`,
                        {},
                        { target },
                    );
                }
                const deleted = await db.crud_delete_channel.get<{ name: string }>({ entry_id: entry.id, name: fragment });
                return deleted === undefined
                    ? failure(
                        "channel-not-found",
                        404,
                        `No channel named #${fragment} exists at ${target}.`,
                        {},
                        {
                            target,
                            channel: fragment,
                        },
                    )
                    : { status: 200 };
            }
            const result = await EntryCrud.deleteEntry(coordinate, ctx, scheme, ownerId);
            return result;
        }

        // SEND signal 499 Client Closed Request — cancel active subscription (SPEC {§send-dispatch}, {§stream-control}).
        // Entry-bearing schemes never have subscriptions in v0; always return 404.
        // Streaming schemes (sse / exec / etc.) override this and look up via
        // findActiveSubscription, then call their teardown using the stored handle.
        if (status === 499) {
            const coordinate = EntrySend.#coordinateOf(statement, manifest);
            if (coordinate === null) return failure("target-required", 400, "`## SEND0 [499]` requires a target path.");
            const { authority, pathname } = coordinate;
            const target = renderAddress({ scheme, authority, pathname });
            const { db, workspaceId, workerId } = ctx;
            const entry = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, owner_id: ownerId, scheme, authority, pathname });
            if (entry === undefined) {
                return failure(
                    "entry-not-found",
                    404,
                    `No entry exists at ${target}.`,
                    {},
                    { target },
                );
            }
            const subscription = await ChannelWrite.findActiveSubscription(db, { workerId, entryId: entry.id });
            if (subscription === null) {
                return failure(
                    "subscription-not-found",
                    404,
                    `No active subscription exists at ${target}.`,
                    {},
                    { target },
                );
            }
            return failure(
                "subscription-owned-elsewhere",
                501,
                `Scheme '${subscription.scheme}' owns cancellation for this subscription.`,
                {},
                {
                    target,
                    owningScheme: subscription.scheme,
                    retryable: false,
                },
            );
        }

        return failure(
            "status-not-implemented",
            501,
            `The '${scheme}' entry scheme does not interpret SEND status ${status}.`,
            {},
            {
                requestedStatus: status,
                retryable: false,
            },
        ); // {§send-dispatch-entry-schemes-501-on-non-410}
    }
}
