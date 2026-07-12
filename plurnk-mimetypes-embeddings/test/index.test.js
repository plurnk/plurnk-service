
test("model identity is pinned and matches .model-pin", async () => {
    const { model } = await import("../index.js");
    const pin = (await import("node:fs/promises")).readFile;
    const pinned = (await pin(new URL("../.model-pin", import.meta.url), "utf8")).trim();
    assert.equal(model, `Xenova/all-MiniLM-L6-v2@${pinned.slice(0, 8)}`);
});
