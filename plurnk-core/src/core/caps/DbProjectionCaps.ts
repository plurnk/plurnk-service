import type { ProjectionCaps } from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";

// Consumer-owned MIME projection for DB-free sibling schemes. The scheme owns
// acquisition; core owns the configured reader family and therefore the exact
// text the model, FIND, embeddings, and weights consume.
export default class DbProjectionCaps implements ProjectionCaps {
    readonly #ctx: PlurnkSchemeContext;

    constructor(ctx: PlurnkSchemeContext) {
        this.#ctx = ctx;
    }

    async readable(content: string, mimetype: string): Promise<{ content: string; mimetype: string } | null> {
        const mimetypes = this.#ctx.mimetypes;
        if (mimetypes === undefined) throw new Error("projection.readable: mimetype registry is required");
        const projected = (await mimetypes.process({ content, hint: mimetype }, { channels: ["content"] })).content;
        return typeof projected === "string" && projected.length > 0
            ? { content: projected, mimetype: "text/markdown" }
            : null;
    }
}
