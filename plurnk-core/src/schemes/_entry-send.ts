// Shared SEND face for entry-bearing schemes: an entry is not a recipient, so every
// message aimed at one is 501 ({§send-dispatch-entry-schemes-501}).

import type { SendStatement } from "@plurnk/plurnk-contracts";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import Results, { type SchemeResult } from "../core/results.ts";

export interface SendResult extends SchemeResult {}

export default class EntrySend {
    static async sendToWorkspaceEntry(statement: SendStatement, ctx: PlurnkSchemeContext, manifest: SchemeManifest): Promise<SendResult> {
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
            `SEND does not deliver messages to ${scheme} entries.`,
            {},
            {
                // {§send-target-recipient}
                recovery: "To reply, SEND to an Open Message address or omit the target. SEND (worker://<name>) sends a new message.",
                retryable: false,
            },
        ); // {§send-dispatch-entry-schemes-501}
    }
}
