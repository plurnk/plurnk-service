import type { DispositionStatement, KillStatement } from "@plurnk/plurnk-contracts";
import { EntryCoordinates, Results, type RepresentationPreparationRequest, type RepresentationPreparationResult, type SchemeCtx, type SchemeResult } from "@plurnk/plurnk-schemes";
import type Scheduler from "./Scheduler.ts";

type RuleList = (workspaceId: number) => Promise<readonly { alias: string; state: string; [key: string]: unknown }[]>;

export default class ScheduleResources {
    readonly #scheduler: Scheduler;
    readonly #list: RuleList;

    constructor(scheduler: Scheduler, list: RuleList) {
        this.#scheduler = scheduler;
        this.#list = list;
    }

    claims(pathname: string): boolean {
        return /^\/(?:rules|waits)(?:\/|$)/u.test(pathname);
    }

    async prepareRepresentation(request: RepresentationPreparationRequest, ctx: SchemeCtx): Promise<RepresentationPreparationResult> {
        if (request.authority !== "") return Results.failure("schedule:resource", "authority-invalid", 400, "Schedule resources use an empty authority.");
        const { pathname } = request;
        const content = pathname.startsWith("/waits/")
            ? await ctx.awaitedEvents.read(pathname)
            : (await this.#list(ctx.workspaceId)).find((rule) => pathname === `/rules/${encodeURIComponent(rule.alias)}`);
        if (content === null || content === undefined) return Results.failure("schedule:resource", "not-found", 404, "The schedule resource does not exist.");
        const result = await ctx.entries.write(pathname, { channels: { results: { content: JSON.stringify(content, null, 2), mimetype: "application/json" } } });
        return result.status >= 400 ? { status: result.status, problem: result.problem } : { status: 200 };
    }

    async wait(statement: DispositionStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        const target = statement.target;
        if (target?.kind !== "url") return Results.failure("schedule:wait", "target-invalid", 400, "WAIT requires a schedule rule resource.");
        const encoded = /^\/rules\/([^/]+)$/u.exec(EntryCoordinates.resolve(target, "namespace").pathname)?.[1];
        if (encoded === undefined) return Results.failure("schedule:wait", "target-invalid", 400, "WAIT requires a schedule rule resource.");
        return this.#scheduler.wait(ctx.workspaceId, encoded, ctx.awaitedEvents);
    }

    async kill(statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        const target = statement.target;
        const pathname = target?.kind === "url" ? EntryCoordinates.resolve(target, "namespace").pathname : "";
        if (!pathname.startsWith("/waits/")) {
            return Results.failure("schedule:resource", "operation-not-implemented", 501, "KILL applies to a wait attachment, not a schedule rule.");
        }
        return ctx.awaitedEvents.cancel(pathname);
    }
}
