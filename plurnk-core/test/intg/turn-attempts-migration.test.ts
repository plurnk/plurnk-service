import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import SqlRiteCore from "@possumtech/sqlrite/core";
import { MIGRATIONS_DIR } from "./_helpers.ts";

test("v11 turns migrate their stored exchange into one accepted provider attempt", () => {
    const db = new DatabaseSync(":memory:");
    try {
        db.exec(`
            CREATE TABLE turns (
                id INTEGER PRIMARY KEY,
                loop_id INTEGER NOT NULL,
                timestamp TEXT NOT NULL,
                packet TEXT NOT NULL CHECK (json_valid(packet)),
                usage_prompt INTEGER NOT NULL,
                usage_completion INTEGER NOT NULL,
                usage_reasoning INTEGER NOT NULL,
                usage_cached INTEGER NOT NULL,
                usage_cost_usd REAL NOT NULL,
                finish_reason TEXT,
                model TEXT NOT NULL,
                meta TEXT NOT NULL CHECK (json_valid(meta))
            ) STRICT;

            INSERT INTO turns VALUES (
                7,
                3,
                '2026-07-28T12:00:00.000Z',
                '{"assistant":{"content":"<<PLAN:p:PLAN\\n<<SEND[200]:done:SEND","ops":[],"reasoning":null},"assistantRaw":{"id":"wire-7"}}',
                11,
                5,
                2,
                4,
                0.125,
                'stop',
                'fixture/model',
                '{"latencyMs":42}'
            );
            PRAGMA user_version = 11;
        `);

        const migration = SqlRiteCore.loadChunks({ dir: MIGRATIONS_DIR }).MIGRATE
            .filter(({ version }) => version === 12);
        assert.equal(migration.length, 1);
        SqlRiteCore.applyMigrations(db, migration);

        const row = db.prepare(`
            SELECT turn_id, sequence, accepted, response, parse_errors,
                   usage_prompt, usage_completion, usage_reasoning, usage_cached,
                   usage_cost_usd, finish_reason, model, timestamp
            FROM turn_attempts
        `).get() as Record<string, unknown>;
        assert.equal(row.turn_id, 7);
        assert.equal(row.sequence, 1);
        assert.equal(row.accepted, 1);
        assert.deepEqual(JSON.parse(String(row.parse_errors)), []);
        assert.equal(row.usage_prompt, 11);
        assert.equal(row.usage_completion, 5);
        assert.equal(row.usage_reasoning, 2);
        assert.equal(row.usage_cached, 4);
        assert.equal(row.usage_cost_usd, 0.125);
        assert.equal(row.finish_reason, "stop");
        assert.equal(row.model, "fixture/model");
        assert.equal(row.timestamp, "2026-07-28T12:00:00.000Z");
        const response = JSON.parse(String(row.response)) as {
            assistant?: { content?: string };
            assistantRaw?: { id?: string };
            meta?: { latencyMs?: number };
        };
        assert.match(response.assistant?.content ?? "", /SEND\[200\]/);
        assert.equal(response.assistantRaw?.id, "wire-7");
        assert.equal(response.meta?.latencyMs, 42);
        assert.throws(
            () => db.prepare(`
                INSERT INTO turn_attempts (
                    turn_id,
                    sequence,
                    accepted,
                    response,
                    model
                )
                VALUES (7, 2, 1, '{}', 'fixture/model')
            `).run(),
            /UNIQUE constraint failed/,
            "a turn can admit at most one provider response",
        );
        assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 12);
    } finally {
        db.close();
    }
});
