// Pool worker for embedBatch (index.js). Loads its own single-threaded runtime
// once, then embeds one text per message. Posts {ready} after load so the pool
// never assigns work before the model is up, and surfaces a load failure instead
// of hanging. Result bytes are transferred (zero-copy) back to the main thread.
import { parentPort } from "node:worker_threads";
import { loadRuntime, embedText, countTokensWith, releaseRuntime } from "./embed-core.js";

let runtime;
try {
    runtime = await loadRuntime();
    parentPort.postMessage({ ready: true, dispose: true });
} catch (e) {
    parentPort.postMessage({ ready: false, error: e.message });
}

let closing = false;
let operation = Promise.resolve();

async function handle({ kind = "embed", text }) {
    try {
        if (kind === "count") {
            parentPort.postMessage({ count: countTokensWith(runtime.tokenizer, text) });
            return;
        }
        const bytes = await embedText(runtime, text);
        parentPort.postMessage({ buffer: bytes.buffer }, [bytes.buffer]);
    } catch (e) {
        parentPort.postMessage({ error: e.message });
    }
}

parentPort.on("message", (message) => {
    if (message.kind === "dispose") {
        if (closing) return;
        closing = true;
        operation = operation.then(async () => {
            try {
                await releaseRuntime(runtime);
                parentPort.postMessage({ disposed: true });
            } catch (e) {
                parentPort.postMessage({ disposed: false, error: e.message });
            } finally {
                parentPort.close();
            }
        });
        return;
    }
    if (closing) return;
    operation = operation.then(() => handle(message));
});
