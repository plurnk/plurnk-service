// {§treesitter-runtime-gate} — web-tree-sitter shares ONE wasm runtime across every grammar
// handler, and its 0.27 `Parser.init()` is `Module ??= await create()`: two concurrent first
// callers instantiate two runtimes and the survivor's parsers hold the loser's pointers
// ("function signature mismatch", "Incompatible language version 0", "memory access out of
// bounds" at teardown — the boa derivation crash, run88). Runtime initialization happens
// once, and dynamic grammar loads (Emscripten side-module linking into that runtime) run
// one at a time. Parsing itself is synchronous and needs no gate.
export interface TreeSitterRuntime {
    Parser: { init(): Promise<void> };
    Language: { load(wasmPath: string): Promise<unknown> };
}

let runtimeInit: Promise<void> | null = null;
let loads: Promise<unknown> = Promise.resolve();

export const initRuntime = (ts: TreeSitterRuntime): Promise<void> => {
    // The promise is assigned synchronously, so a second caller joins the first init.
    runtimeInit ??= ts.Parser.init();
    return runtimeInit;
};

export const loadLanguage = async (ts: TreeSitterRuntime, wasmPath: string): Promise<unknown> => {
    await initRuntime(ts);
    const load = loads.then(() => ts.Language.load(wasmPath));
    // A failed load must not poison later loads; the caller receives its own rejection.
    loads = load.then(() => undefined, () => undefined);
    return load;
};
