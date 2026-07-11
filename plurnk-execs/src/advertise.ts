import type { ExecInfo, ExecRegistry } from "./types.ts";

// The EXEC family's per-loop capability contribution (SPEC §3.4, execs#24).
export default class Advertise {
    // A factual state, not a permission verb — "permitted"/"forbidden" reads as a
    // behavioral prohibition the model over-applies (SPEC §3.4).
    static readonly NO_EXECS_NOTICE = "No EXEC runtimes are active";

    static contribute(
        registry: ExecRegistry,
        isPermitted: (tag: string) => boolean,
    ): { permitted: ExecInfo[]; notice: string | null } {
        const permitted = [...registry.values()].filter(({ runtime }) => isPermitted(runtime));
        return { permitted, notice: permitted.length === 0 ? Advertise.NO_EXECS_NOTICE : null };
    }
}
