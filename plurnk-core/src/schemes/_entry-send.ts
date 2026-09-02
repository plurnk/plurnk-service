// Shared SEND face for entry-bearing schemes: an entry is not a recipient, so every
// message aimed at one is 501 ({§send-dispatch-entry-schemes-501}).

import type { SendStatement } from "@plurnk/plurnk-contracts";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import Results, { type SchemeResult } from "../core/results.ts";

export interface SendResult extends SchemeResult {}

export default class EntrySend {
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

        return failure(
            "message-not-implemented",
            501,
            `The '${scheme}' entry scheme carries no messages.`,
            {},
            {
                // {§send-target-recipient} — the model most likely meant the reply, which carries no target.
                recovery: "`## SEND0 (TERM)` answers the active prompt with no target. A SEND target is a recipient — `## SEND0 (worker://<name>)` — or, with `[410]`, a resource to delete.",
                retryable: false,
            },
        ); // {§send-dispatch-entry-schemes-501}
    }
}
