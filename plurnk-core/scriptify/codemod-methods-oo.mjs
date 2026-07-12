// Slice 3 of the OO audit: wrap each server/methods register-module into an
// `export default class XMethod { static register(...) }`, rewrite the
// dispatchAsClient helper calls, and repoint Daemon's imports + invocations.
// The wrap re-indents the register body +4 (no multi-line templates in these
// files, verified, so leading-whitespace insertion is safe). entry_read,
// log_read (helpers) and _dispatchAsClient (the helper itself) are hand-done.
// Verified by tsc + the test run.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export default class MethodsOoCodemod {
    static #REPO = join(import.meta.dirname, "..");
    static #DIR = "src/server/methods";

    static #SIMPLE = [
        "ping", "discover",
        "session_create", "session_list", "session_attach", "session_runs",
        "session_set_root", "session_set_persona",
        "op_edit", "op_read", "op_find", "op_show", "op_hide", "op_copy",
        "op_move", "op_send", "op_exec", "op_dispatch", "op_parse",
        "loop_run", "loop_cancel", "loop_resolve",
        "providers_list",
    ];

    static #pascal(file) {
        return file.split("_").map((s) => s[0].toUpperCase() + s.slice(1)).join("");
    }

    static #wrapRegister(text, className) {
        const lines = text.split("\n");
        const openIdx = lines.findIndex((l) => l.trimStart().startsWith("export const register = (registry: MethodRegistry): void => {"));
        if (openIdx === -1) return null;
        let closeIdx = -1;
        for (let i = lines.length - 1; i > openIdx; i--) {
            if (lines[i].trim() === "};") { closeIdx = i; break; }
        }
        if (closeIdx === -1) return null;
        for (let i = openIdx + 1; i < closeIdx; i++) {
            if (lines[i].trim() !== "") lines[i] = `    ${lines[i]}`;
        }
        lines[openIdx] = `export default class ${className} {\n    static register(registry: MethodRegistry): void {`;
        lines[closeIdx] = "    }\n}";
        return lines.join("\n");
    }

    static async run() {
        for (const file of MethodsOoCodemod.#SIMPLE) {
            const full = join(MethodsOoCodemod.#REPO, MethodsOoCodemod.#DIR, `${file}.ts`);
            let text = await readFile(full, "utf8");
            text = text.replace(
                /import \{ dispatchAsClient \} from "\.\/_dispatchAsClient\.ts";/,
                'import DispatchAsClient from "./_dispatchAsClient.ts";',
            );
            text = text.replace(/(?<![\w.])dispatchAsClient(?=\()/g, "DispatchAsClient.dispatch");
            const wrapped = MethodsOoCodemod.#wrapRegister(text, `${MethodsOoCodemod.#pascal(file)}Method`);
            if (wrapped === null) { console.log(`SKIP (no register) ${file}`); continue; }
            await writeFile(full, wrapped);
            console.log(`wrapped ${file} -> ${MethodsOoCodemod.#pascal(file)}Method`);
        }

        const daemonPath = join(MethodsOoCodemod.#REPO, "src/server/Daemon.ts");
        let daemon = await readFile(daemonPath, "utf8");
        daemon = daemon.replace(
            /import \{ register as register(\w+) \} from "(\.\/methods\/\w+\.ts)";/g,
            'import $1Method from "$2";',
        );
        daemon = daemon.replace(/register(\w+)\(this\.#registry\)/g, "$1Method.register(this.#registry)");
        await writeFile(daemonPath, daemon);
        console.log("rewrote Daemon.ts imports + calls");
    }
}

await MethodsOoCodemod.run();
