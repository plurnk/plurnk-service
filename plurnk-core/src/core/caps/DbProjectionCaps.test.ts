import test from "node:test";
import assert from "node:assert/strict";
import DbProjectionCaps from "./DbProjectionCaps.ts";
import type { PlurnkSchemeContext } from "../scheme-types.ts";

const context = (content: string | undefined): PlurnkSchemeContext => ({
    mimetypes: {
        async process() {
            return content === undefined
                ? { mimetype: "text/html", ok: true, totalLines: 1 }
                : { mimetype: "text/html", ok: true, totalLines: 1, content };
        },
    },
} as unknown as PlurnkSchemeContext);

test("readable preserves a present empty projection and reserves null for absence", async () => {
    assert.deepEqual(
        await new DbProjectionCaps(context("")).readable("<div></div>", "text/html"),
        { content: "", mimetype: "text/markdown" },
    );
    assert.equal(
        await new DbProjectionCaps(context(undefined)).readable("<div></div>", "text/html"),
        null,
    );
});
