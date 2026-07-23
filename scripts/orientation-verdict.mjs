#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const flattenOps = (record) =>
    Array.isArray(record?.turns)
        ? record.turns.flatMap((turn) => Array.isArray(turn?.ops) ? turn.ops : [])
        : [];

const evidenceNames = (response) => {
    const matches = String(response).matchAll(/(?:^|[\s`("'[])((?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+|AGENTS\.md|README\.md|package\.json|#[0-9]+)(?=$|[\s`)"'\],.:;])/gm);
    return [...new Set([...matches].map((match) => match[1]))];
};

const inspectedEvidence = (ops, evidence) => {
    const targets = ops
        .filter((op) => ["READ", "FIND"].includes(op?.op) && Number(op?.status) < 400)
        .map((op) => String(op?.target ?? ""));
    return evidence.filter((name) => targets.some((target) =>
        target.endsWith(name)
        || target.endsWith(`/${name}`)
        || (name.startsWith("#") && target.includes("github")),
    ));
};

const setupErrors = (digest) => {
    const workers = new Map((digest?.workers ?? []).map((worker) => [worker.id, worker]));
    const loops = new Map((digest?.loops ?? []).map((loop) => [loop.id, loop]));
    const turns = new Map((digest?.turns ?? []).map((turn) => [turn.id, turn]));
    return (digest?.log_entries ?? []).filter((entry) => {
        if (Number(entry?.status_rx) < 400) return false;
        const turn = turns.get(entry.turn_id);
        const loop = loops.get(turn?.loop_id);
        return workers.get(loop?.worker_id)?.name === "plurnk";
    });
};

const includesEveryGroup = (text, groups) =>
    groups.every((group) => group.some((term) => text.includes(term)));

export const evaluateOrientation = (record, digest) => {
    const response = typeof record?.response === "string" ? record.response.trim() : "";
    const lower = response.toLowerCase();
    const ops = flattenOps(record);
    const inspectionOps = ops.filter((op) =>
        ["READ", "FIND", "EXEC"].includes(op?.op) && Number(op?.status) < 400);
    const evidence = evidenceNames(response);
    const verifiedEvidence = inspectedEvidence(ops, evidence);
    const publicationErrors = setupErrors(digest);

    const checks = {
        lifecycle: {
            pass: record?.schemaVersion === 1
                && record?.finalStatus === 200
                && record?.hitMaxTurns === false
                && record?.timedOut === false
                && response.length > 0,
            detail: {
                schemaVersion: record?.schemaVersion ?? null,
                finalStatus: record?.finalStatus ?? null,
                hitMaxTurns: record?.hitMaxTurns ?? null,
                timedOut: record?.timedOut ?? null,
                responseChars: response.length,
            },
        },
        workspacePublication: {
            pass: publicationErrors.length === 0,
            detail: { failedOperations: publicationErrors.length },
        },
        inspection: {
            pass: inspectionOps.length >= 3
                && inspectionOps.some((op) => op.op === "READ"),
            detail: {
                successfulRetrievals: inspectionOps.length,
                operations: [...new Set(inspectionOps.map((op) => op.op))],
            },
        },
        evidence: {
            pass: evidence.length >= 3 && verifiedEvidence.length >= 2,
            detail: { named: evidence, verified: verifiedEvidence },
        },
        coverage: {
            pass: includesEveryGroup(lower, [
                ["daemon", "service"],
                ["grammar", "dsl"],
                ["client", "ag-ui", "agui"],
                ["monorepo", "topology", "repository", "repositories"],
                ["stabil", "housekeeping", "acceptance"],
                ["missing", "contradiction", "unclear", "gap", "risk"],
            ]) && response.includes("#583"),
            detail: {
                required: [
                    "daemon/service",
                    "grammar/DSL",
                    "client/AG-UI",
                    "repository topology",
                    "current stabilization goal (#583)",
                    "missing or contradictory context",
                ],
            },
        },
    };

    const failed = Object.entries(checks)
        .filter(([, check]) => !check.pass)
        .map(([name]) => name);
    return {
        schemaVersion: 1,
        pass: failed.length === 0,
        failed,
        checks,
        model: digest?.turns?.findLast?.((turn) => typeof turn?.model === "string")?.model ?? null,
        costPico: record?.usage?.costPico ?? null,
    };
};

const main = async () => {
    const [recordPath, digestPath] = process.argv.slice(2);
    if (recordPath === undefined || digestPath === undefined) {
        throw new Error("usage: orientation-verdict <client.json> <digest.json>");
    }
    const [record, digest] = await Promise.all([
        readFile(recordPath, "utf8").then(JSON.parse),
        readFile(digestPath, "utf8").then(JSON.parse),
    ]);
    const verdict = evaluateOrientation(record, digest);
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
    process.exitCode = verdict.pass ? 0 : 1;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
