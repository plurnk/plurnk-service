import type { ParsedPath } from "@plurnk/plurnk-contracts";
import type { SchemeResultBase } from "@plurnk/plurnk-schemes";
import Results from "./results.ts";

type WorkerControlOperation = "WORK" | "FORK" | "SEND" | "READ" | "KILL";

type WorkerControlAddressResolution =
    | { readonly ok: true; readonly authority: string }
    | { readonly ok: false; readonly result: SchemeResultBase };

// {§worker-control-addressing} Generic URI parsing remains permissive, but a
// worker-as-actor address is exactly an authority with no other URI component.
export default class WorkerControlAddress {
    static render(authority: string): string {
        return `worker://${authority}`;
    }

    static resolve(target: ParsedPath | null, operation: WorkerControlOperation): WorkerControlAddressResolution {
        const authority = WorkerControlAddress.#authorityOf(target);
        if (authority !== null) return { ok: true, authority };
        return {
            ok: false,
            result: Results.failure(
                "scheme:worker",
                "control-address-invalid",
                400,
                `${operation} requires an authority-only worker:// control address.`,
                {},
                {
                    operation,
                    recovery: "Provide one worker authority and remove every other URI component.",
                    retryable: false,
                },
            ),
        };
    }

    static #authorityOf(target: ParsedPath | null): string | null {
        if (target === null || target.kind !== "url" || target.scheme !== "worker") return null;
        const authority = target.hostname;
        if (authority === null || authority.length === 0) return null;
        if (
            target.username !== null
            || target.password !== null
            || target.port !== null
            || target.pathname !== ""
            || target.query !== null
            || target.fragment !== null
        ) return null;

        // Parsed fields cannot distinguish an absent empty fragment from `#`,
        // and WHATWG may normalize dot paths. The preserved spelling closes
        // both gaps without constraining the generic parser.
        const delimiter = target.raw.indexOf("://");
        if (delimiter === -1 || target.raw.slice(0, delimiter).toLowerCase() !== "worker") return null;
        return target.raw.slice(delimiter + 3) === authority ? authority : null;
    }
}
