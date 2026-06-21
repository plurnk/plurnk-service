// Pool worker for embedBatch (index.js). Loads its own single-threaded runtime
// once, then embeds one text per message. Posts {ready} after load so the pool
// never assigns work before the model is up, and surfaces a load failure instead
// of hanging. Result bytes are transferred (zero-copy) back to the main thread.
import { parentPort } from "node:worker_threads";
import { loadRuntime, embedText } from "./embed-core.js";

let runtime;
try {
    runtime = await loadRuntime();
    parentPort.postMessage({ ready: true });
} catch (e) {
    parentPort.postMessage({ ready: false, error: e.message });
}

parentPort.on("message", async ({ index, text }) => {
    try {
        const bytes = await embedText(runtime, text);
        parentPort.postMessage({ index, buffer: bytes.buffer }, [bytes.buffer]);
    } catch (e) {
        parentPort.postMessage({ index, error: e.message });
    }
});
