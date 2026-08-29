// One model-facing embedding contract, with implementation families selected
// before import. A configured provider never loads the bundled ONNX/tokenizer
// runtime; the bundled local path never loads provider constructors.
const selector = process.env.PLURNK_EMBEDDING_MODEL?.trim();
const adapter = selector === undefined || selector === ""
    ? await import("./local.js")
    : await import("./configured.js").then(({ resolveConfiguredEmbedder }) => {
        const configured = resolveConfiguredEmbedder();
        if (configured === null) throw new Error("configured embedding selector resolved no adapter");
        return configured;
    });

export const dimension = adapter.dimension;
export const contextWindow = adapter.contextWindow;
export const tokenizerModel = adapter.tokenizerModel;
export const model = adapter.model;
export const countTokens = adapter.countTokens;

export const embedQuery = (text, options) => adapter.embedQuery(text, options);
export const embedDocuments = (texts, options) => adapter.embedDocuments(texts, options);
export const dispose = () => adapter.dispose();
