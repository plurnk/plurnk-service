import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import wabtInit from "wabt";
import { BaseExecutor, ErrorDetail, renderJsonResult, Results } from "@plurnk/plurnk-execs";
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
// application/json. A module cannot touch the host beyond the imports supplied,
// so an inline call is `pure` and bypasses proposal admission. Its result still
// follows the universal background stream path ({§executor-effect}).
export default class Wasm extends BaseExecutor {
    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { results: { mimetype: "application/json" } };
    }

    // Inline body is sandboxed → `pure`. A file-path target reads the
    // host filesystem → `read` (execution stays sandboxed; the FS read is the
    // only host interaction). Target-classified, never command-inspected.
    override effect(target: string | null): Effect {
        return target ? "read" : "pure";
    }

    override async probe(): Promise<RuntimeAvailability> {
        return { available: true, detail: "WebAssembly + wabt" };
    }

    async run({ runtime, command, cwd, target, signal, write, setState }: ExecArgs): Promise<ExecResult> {
        const fail = (
            kind: string,
            message: string,
            status = 500,
            extensions: Readonly<Record<string, unknown>> = {},
        ): ExecResult => {
            setState("results", "errored");
            return Results.failure(
                "executor:wasm",
                kind,
                status,
                message,
                {},
                {
                    runtime,
                    ...extensions,
                },
            );
        };
        const detailLimit = ErrorDetail.configuredLimit();
        if (detailLimit === null) {
            setState("results", "errored");
            return ErrorDetail.invalidConfiguration("executor:wasm");
        }
        // Honor an abort at each phase boundary ({§executor-cancellation}). The file read, wabt init,
        // and instantiate are the await points where a KILL/cancel can land; the
        // entry-point call itself is synchronous and uninterruptible.
        const aborted = (): ExecResult => {
            setState("results", "errored");
            return Results.failure(
                "executor:wasm",
                "cancelled",
                499,
                "WebAssembly execution was cancelled.",
                {},
                {
                    runtime,
                    stage: "execution",
                    retryable: false,
                },
            );
        };
        if (signal.aborted) return aborted();
        // target = a module file, resolved against cwd (the workspace) —
        // {§executor-sinks}; otherwise the module rides the body (WAT / base64).
        const path = target === null ? null : (isAbsolute(target) ? target : resolve(cwd ?? process.cwd(), target));

        // 1. Obtain the module bytes — from the file-path target, else the body.
        let bytes: Uint8Array;
        if (runtime === "wat") {
            let watText: string;
            if (path !== null) {
                try { watText = await readFile(path, "utf8"); }
                catch (err) {
                    const code = (err as NodeJS.ErrnoException).code;
                    return fail(
                        "wasm-read-failed",
                        `WebAssembly could not read '${path}': ${ErrorDetail.preview(err, detailLimit)}`,
                        code === "ENOENT" ? 404 : 500,
                        {
                            stage: "read",
                            target: path,
                            errorCode: code,
                            recovery: "Use a readable module target.",
                            retryable: false,
                        },
                    );
                }
            } else {
                watText = command;
            }
            let wabt: Wabt;
            try { wabt = await getWabt(); }
            catch (err) {
                return fail(
                    "wabt-init-failed",
                    `The WebAssembly text compiler failed to initialize: ${ErrorDetail.preview(err, detailLimit)}`,
                    500,
                    {
                        stage: "compiler-initialization",
                    },
                );
            }
            let mod: ReturnType<Wabt["parseWat"]> | undefined;
            try {
                mod = wabt.parseWat(path ?? "module.wat", watText);
                bytes = mod.toBinary({}).buffer;
            } catch (err) {
                return fail(
                    "wat-parse-error",
                    `The WebAssembly text module is invalid: ${ErrorDetail.preview(err, detailLimit)}`,
                    400,
                    {
                        stage: "parse",
                        recovery: "Correct the WebAssembly text module.",
                        retryable: false,
                    },
                );
            } finally {
                mod?.destroy();
            }
        } else if (runtime === "wasm") {
            if (path !== null) {
                try { bytes = await readFile(path); }
                catch (err) {
                    const code = (err as NodeJS.ErrnoException).code;
                    return fail(
                        "wasm-read-failed",
                        `WebAssembly could not read '${path}': ${ErrorDetail.preview(err, detailLimit)}`,
                        code === "ENOENT" ? 404 : 500,
                        {
                            stage: "read",
                            target: path,
                            errorCode: code,
                            recovery: "Use a readable module target.",
                            retryable: false,
                        },
                    );
                }
            } else {
                bytes = Uint8Array.from(Buffer.from(command.trim(), "base64"));
            }
        } else {
            throw new Error(`plurnk-execs-wasm received unclaimed runtime tag '${runtime}'`);
        }

        if (signal.aborted) return aborted();
        // 2. Instantiate in the sandbox (only the log-capture import).
        const log: unknown[] = [];
        let instance: { exports: Record<string, unknown> };
        try {
            ({ instance } = await WebAssembly.instantiate(bytes, { env: { log: (v: unknown) => log.push(v) } }));
        } catch (err) {
            return fail(
                "wasm-invalid",
                `The WebAssembly module could not be instantiated: ${ErrorDetail.preview(err, detailLimit)}`,
                400,
                {
                    stage: "instantiate",
                    recovery: "Correct the WebAssembly module.",
                    retryable: false,
                },
            );
        }

        if (signal.aborted) return aborted();
        // 3. Call the entry point if present; capture its return.
        const exports = instance.exports;
        const funcs = Object.keys(exports).filter((n) => typeof exports[n] === "function");
        const entry = ENTRY_POINTS.find((n) => funcs.includes(n)) ?? (funcs.length === 1 ? funcs[0] : undefined);
        let returned: unknown = null;
        if (entry !== undefined) {
            try { returned = (exports[entry] as () => unknown)(); }
            catch (err) {
                return fail(
                    "wasm-trap",
                    `WebAssembly entry point '${entry}' trapped: ${ErrorDetail.preview(err, detailLimit)}`,
                    500,
                    {
                        stage: "execution",
                        entryPoint: entry,
                        recovery: "Correct the module's execution path.",
                        retryable: false,
                    },
                );
            }
        }

        write("results", renderJsonResult({ returned, log, exports: funcs }, jsonReplacer));
        setState("results", "closed");
        return { status: 200 };
    }
}
