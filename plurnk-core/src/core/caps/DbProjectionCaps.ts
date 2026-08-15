import type { ProjectedText, ProjectionCaps } from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";
import ErrorDetail from "../ErrorDetail.ts";

// Consumer-owned MIME projection for DB-free sibling schemes. The scheme owns
// acquisition; core owns the configured reader family and therefore the exact
// text the model, FIND, embeddings, and weights consume.
export default class DbProjectionCaps implements ProjectionCaps {
    readonly #ctx: PlurnkSchemeContext;

    constructor(ctx: PlurnkSchemeContext) {
        this.#ctx = ctx;
    }

    async readable(content: string, mimetype: string): Promise<ProjectedText | null> {
        const mimetypes = this.#ctx.mimetypes;
        if (mimetypes === undefined) throw new Error("projection.readable: mimetype registry is required");
        const projected = await mimetypes.projectReadable({ content, hint: mimetype });
        return projected === null ? null : { ...projected, mimetype: "text/markdown" };
    }

    async readableBytes(chunks: AsyncIterable<Uint8Array>, mimetype: string): Promise<ProjectedText | null> {
        const mimetypes = this.#ctx.mimetypes;
        if (mimetypes === undefined) throw new Error("projection.readableBytes: mimetype registry is required");
        const projected = await mimetypes.projectReadableStream(chunks, mimetype);
        return projected === null ? null : { ...projected, mimetype: "text/markdown" };
    }

    async identity(mimetype: string): Promise<string> {
        const mimetypes = this.#ctx.mimetypes;
        if (mimetypes === undefined) throw new Error("projection.identity: mimetype registry is required");
        return mimetypes.projectionIdentity(mimetype);
    }

    async isBinary(mimetype: string): Promise<boolean> {
        const mimetypes = this.#ctx.mimetypes;
        if (mimetypes === undefined) throw new Error("projection.isBinary: mimetype registry is required");
        return (await mimetypes.classify(mimetype)).binary;
    }

    async parseIssues(content: string, mimetype: string): Promise<number | undefined> {
        try {
            const mimetypes = this.#ctx.mimetypes;
            if (mimetypes === undefined) {
                throw new Error("configured mimetype registry is required");
            }
            const result = await mimetypes.process(
                { content, hint: mimetype },
                { channels: [], parseIssues: true },
            );
            for (const notice of result.notices ?? []) this.#ctx.pushNotice?.(notice);
            return result.parseIssues;
        } catch (cause) {
            const detail = ErrorDetail.preview(cause);
            const notice = {
                source: "engine:mimetype",
                kind: "parse_issues_unavailable",
                level: "warn" as const,
                message: `Parser recovery evidence unavailable for ${mimetype}: ${detail}`,
            };
            if (this.#ctx.pushNotice === undefined) {
                console.error(notice.message, cause);
            } else {
                this.#ctx.pushNotice(notice);
            }
            return undefined;
        }
    }
}
