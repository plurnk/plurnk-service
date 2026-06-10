import wabtInit from "wabt";
import { BaseExecutor } from "@plurnk/plurnk-execs";
import type { ChannelDecl, Effect, ExecArgs, ExecResult, RuntimeAvailability } from "@plurnk/plurnk-execs";

// `WebAssembly` is a Node/JS global; declare the subset we use so the build
// needs no TS DOM lib (this is a Node package).
declare const WebAssembly: {
    instantiate(
        bytes: Uint8Array,
        imports: Record<string, Record<string, unknown>>,
    ): Promise<{ instance: { exports: Record<string, unknown> } }>;
};

// wabt is an async-initialized WASM module; load it once, lazily.
type Wabt = Awaited<ReturnType<typeof wabtInit>>;
let wabtPromise: Promise<Wabt> | undefined;
const getWabt = (): Promise<Wabt> => (wabtPromise ??= wabtInit());

// WASM i64 results come back as bigint; stringify so the JSON serializes.
const jsonReplacer = (_key: string, value: unknown): unknown =>
    (typeof value === "bigint" ? value.toString() : value);

// Entry-point export names tried in order; falls back to the sole exported
// function if a module exports exactly one.
const ENTRY_POINTS = ["main", "_start"];

// In-process WebAssembly executor (a logical runtime). `wat` assembles the
// model's WebAssembly Text via wabt; `wasm` decodes a base64 binary module.
// Both instantiate in a sandbox — the only host interaction is an `env.log`
// import that captures values — call the entry point, and return its result as
// application/json. effect `pure`: a module cannot touch the host, only call
// the imports we hand it, so it auto-runs inline. The safe arbitrary-execution
// tier `node -e` can't be.
export default class Wasm extends BaseExecutor {
    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { results: { mimetype: "application/json" } };
    }

    override effect(_target: string | null): Effect {
        return "pure";
    }

    override async probe(): Promise<RuntimeAvailability> {
        return { available: true, detail: "WebAssembly + wabt" };
    }

    async run({ runtime, command, write, setState, emit }: ExecArgs): Promise<ExecResult> {
        const fail = (kind: string, message: string): ExecResult => {
            emit({ source: `exec:${runtime}`, kind, message });
            setState("results", "errored");
            return { status: 500 };
        };

        // 1. Obtain the module bytes.
        let bytes: Uint8Array;
        if (runtime === "wat") {
            let wabt: Wabt;
            try { wabt = await getWabt(); }
            catch (err) { return fail("wabt_init_failed", (err as Error).message); }
            let mod: ReturnType<Wabt["parseWat"]> | undefined;
            try {
                mod = wabt.parseWat("module.wat", command);
                bytes = mod.toBinary({}).buffer;
            } catch (err) {
                return fail("wat_parse_error", (err as Error).message);
            } finally {
                mod?.destroy();
            }
        } else if (runtime === "wasm") {
            bytes = Uint8Array.from(Buffer.from(command.trim(), "base64"));
        } else {
            throw new Error(`plurnk-execs-wasm received unclaimed runtime tag '${runtime}'`);
        }

        // 2. Instantiate in the sandbox (only the log-capture import).
        const log: unknown[] = [];
        let instance: { exports: Record<string, unknown> };
        try {
            ({ instance } = await WebAssembly.instantiate(bytes, { env: { log: (v: unknown) => log.push(v) } }));
        } catch (err) {
            return fail("wasm_invalid", (err as Error).message);
        }

        // 3. Call the entry point if present; capture its return.
        const exports = instance.exports;
        const funcs = Object.keys(exports).filter((n) => typeof exports[n] === "function");
        const entry = ENTRY_POINTS.find((n) => funcs.includes(n)) ?? (funcs.length === 1 ? funcs[0] : undefined);
        let returned: unknown = null;
        if (entry !== undefined) {
            try { returned = (exports[entry] as () => unknown)(); }
            catch (err) { return fail("wasm_trap", `${entry}: ${(err as Error).message}`); }
        }

        write("results", JSON.stringify({ returned, log, exports: funcs }, jsonReplacer));
        setState("results", "closed");
        return { status: 200 };
    }
}
