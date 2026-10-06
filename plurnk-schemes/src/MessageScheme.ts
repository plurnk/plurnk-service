import { PathSyntax, type ParsedPath, type SendStatement, type FindStatement } from "@plurnk/plurnk-contracts";
import type { SchemeHandler, RepresentationPreparationRequest } from "./handler.ts";
import type { SchemeAddressCtx, SchemeCtx } from "./ctx.ts";
import type { SchemeManifest } from "./types.ts";
import Results from "./Results.ts";

/** {§message-source-scheme}: protocol modules name resources; Core retains and accounts for messages. */
export default class MessageScheme implements SchemeHandler {
    readonly manifest: SchemeManifest;

    constructor(name: string) {
        this.manifest = {
            name, authority: "resource", category: "data", channels: { body: "text/markdown" },
            defaultChannel: "body", writableBy: ["model", "client", "_plurnk"],
            volatile: false, modelVisible: true, folderScopes: true, textEditScopes: false,
        };
    }

    async resolveEntryAddress(target: ParsedPath, _ctx: SchemeAddressCtx, access: "read" | "write" = "read") {
        // {§message-immutable-recovery} — immutable evidence is neither a reply nor a lifecycle control.
        if (access === "write") return Results.failure(
            `scheme:${this.manifest.name}`, "message-immutable", 405,
            `\`${target.raw}\` is a received message; it cannot be edited, moved or killed.`,
            {},
            { retryable: false, recovery: `Reply with \`SEND (${target.raw})\` and a body, or conclude the loop with parameterless KILL.` },
        );
        if (target.kind !== "url") return null;
        return {
            authority: target.hostname ?? "",
            pathname: PathSyntax.decodeParens(target.pathname) + (target.query === null ? "" : `?${target.query}`),
        };
    }

    async prepareRepresentation(request: RepresentationPreparationRequest, ctx: SchemeCtx) {
        return ctx.messages.prepare(request.target.raw);
    }

    async prepareFind(_statement: FindStatement, ctx: SchemeCtx) {
        return ctx.messages.prepare();
    }

    async send(statement: SendStatement, ctx: SchemeCtx) {
        return ctx.messages.reply(statement);
    }
}
