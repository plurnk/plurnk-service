import type { ExecInfo, ExecRegistry } from "./types.ts";

// The EXEC family's per-loop capability contribution (SPEC §3.4, execs#24).
export default class Advertise {
    // "permitted", not "disabled": cause-agnostic (SPEC §3.4).
    static readonly NO_EXECS_NOTICE = "No EXEC operations permitted";

    static contribute(
        registry: ExecRegistry,
        isPermitted: (tag: string) => boolean,
    ): { permitted: ExecInfo[]; notice: string | null } {
        const permitted = [...registry.values()].filter(({ runtime }) => isPermitted(runtime));
        return { permitted, notice: permitted.length === 0 ? Advertise.NO_EXECS_NOTICE : null };
    }
}
