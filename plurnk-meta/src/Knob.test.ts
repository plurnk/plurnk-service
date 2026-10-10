import test from "node:test";
import assert from "node:assert/strict";
import Knob from "./Knob.ts";
import ConfigurationError from "./ConfigurationError.ts";

const withEnv = (name: string, value: string | undefined, body: () => void): void => {
    const prior = process.env[name];
    try {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
        body();
    } finally {
        if (prior === undefined) delete process.env[name]; else process.env[name] = prior;
    }
};

test("{§env-knob} a knob is the panel's value, read from the system environment", () => {
    withEnv("PLURNK_TEST_KNOB", "7", () => assert.equal(Knob.integer("PLURNK_TEST_KNOB", 0), 7));
    withEnv("PLURNK_TEST_KNOB", "-1", () => assert.equal(Knob.integer("PLURNK_TEST_KNOB", -1), -1, "a sentinel the floor admits is a value"));
    withEnv("PLURNK_TEST_KNOB", " a, b ,,c ", () => assert.deepEqual(Knob.list("PLURNK_TEST_KNOB"), ["a", "b", "c"]));
    withEnv("PLURNK_TEST_KNOB", "", () => assert.deepEqual(Knob.list("PLURNK_TEST_KNOB"), [], "the panel's empty value is the empty list"));
    withEnv("PLURNK_TEST_KNOB", "1", () => assert.equal(Knob.flag("PLURNK_TEST_KNOB"), true));
    withEnv("PLURNK_TEST_KNOB", "0", () => assert.equal(Knob.flag("PLURNK_TEST_KNOB"), false));
    withEnv("PLURNK_TEST_KNOB", "reject", () => assert.equal(Knob.choice("PLURNK_TEST_KNOB", ["accept", "reject"]), "reject"));
    withEnv("PLURNK_TEST_KNOB", "80%", () => assert.equal(Knob.percent("PLURNK_TEST_KNOB"), 0.8));
    withEnv("PLURNK_TEST_KNOB", "12.5%", () => assert.equal(Knob.percent("PLURNK_TEST_KNOB"), 0.125));
});

test("{§env-knob} missing floor and invalid operator input have distinct typed failures naming the key", () => {
    withEnv("PLURNK_TEST_KNOB", undefined, () => {
        assert.throws(() => Knob.text("PLURNK_TEST_KNOB"), (error: unknown) => {
            assert.ok(error instanceof Error && !(error instanceof ConfigurationError));
            assert.match(error.message, /PLURNK_TEST_KNOB is missing from the assembled environment floor/u);
            return true;
        });
        assert.throws(() => Knob.integer("PLURNK_TEST_KNOB", 0), /missing from the assembled environment floor/);
    });
    for (const bad of ["banana", "", " ", "1.5", "9007199254740993"]) {
        withEnv("PLURNK_TEST_KNOB", bad, () => assert.throws(() => Knob.integer("PLURNK_TEST_KNOB", 0), (error: unknown) => {
            assert.ok(error instanceof ConfigurationError);
            assert.equal(error.key, "PLURNK_TEST_KNOB");
            assert.match(error.message, /PLURNK_TEST_KNOB must be a safe integer of at least 0/u);
            return true;
        }));
    }
    // A bound limits what the operator may say; it is never a value used in the operator's place.
    withEnv("PLURNK_TEST_KNOB", "0", () => assert.throws(() => Knob.integer("PLURNK_TEST_KNOB", 1), /at least 1; got "0"/));
    for (const bad of ["", "true", "yes", "2", " 1"]) {
        withEnv("PLURNK_TEST_KNOB", bad, () => assert.throws(() => Knob.flag("PLURNK_TEST_KNOB"), /PLURNK_TEST_KNOB must be 0 or 1; got /, JSON.stringify(bad)));
    }
    for (const bad of ["80", "0%", "100%", "-5%", "%", ""]) {
        withEnv("PLURNK_TEST_KNOB", bad, () => assert.throws(() => Knob.percent("PLURNK_TEST_KNOB"), /PLURNK_TEST_KNOB must be a percentage in \(0, 100\); got /, JSON.stringify(bad)));
    }
    withEnv("PLURNK_TEST_KNOB", "review", () => assert.throws(
        () => Knob.choice("PLURNK_TEST_KNOB", ["accept", "reject"]),
        /PLURNK_TEST_KNOB must be one of accept, reject; got "review"/,
    ));
});

test("{§env-knob} no reader accepts a value: a default cannot be written at a read", () => {
    assert.equal(Knob.text.length, 1);
    assert.equal(Knob.list.length, 1);
    assert.equal(Knob.integer.length, 2, "a name and a bound, and nothing that could stand in for the panel");
    assert.equal(Knob.flag.length, 1);
    assert.equal(Knob.percent.length, 1);
    assert.equal(Knob.choice.length, 2, "a name and a vocabulary, and nothing that could stand in for the panel");
});

test("{§env-knob} a supplied assembled environment is authoritative and never falls through to the process", () => {
    withEnv("PLURNK_TEST_KNOB", "ambient", () => {
        const env = Object.freeze({ PLURNK_TEST_KNOB: "7" });
        assert.equal(Knob.text("PLURNK_TEST_KNOB", env), "7");
        assert.equal(Knob.integer("PLURNK_TEST_KNOB", 1, env), 7);
        assert.deepEqual(Knob.list("PLURNK_TEST_KNOB", { PLURNK_TEST_KNOB: "a,b" }), ["a", "b"]);
        assert.equal(Knob.flag("PLURNK_TEST_KNOB", { PLURNK_TEST_KNOB: "0" }), false);
        assert.equal(Knob.choice("PLURNK_TEST_KNOB", ["review", "accept"], { PLURNK_TEST_KNOB: "review" }), "review");
        assert.equal(Knob.percent("PLURNK_TEST_KNOB", { PLURNK_TEST_KNOB: "75%" }), 0.75);
        assert.throws(() => Knob.text("PLURNK_TEST_KNOB", {}), {
            message: "PLURNK_TEST_KNOB is missing from the assembled environment floor.",
        });
        assert.throws(() => Knob.flag("PLURNK_TEST_KNOB", { PLURNK_TEST_KNOB: "true" }), {
            message: 'PLURNK_TEST_KNOB must be 0 or 1; got "true".',
        });
        assert.equal(process.env.PLURNK_TEST_KNOB, "ambient", "validation does not write into the process environment");
    });
});

test("{§env-knob} an optional knob is null when unset or empty and a validated integer when present", () => {
    withEnv("PLURNK_TEST_OPTIONAL", undefined, () => assert.equal(Knob.optionalInteger("PLURNK_TEST_OPTIONAL", 1), null));
    withEnv("PLURNK_TEST_OPTIONAL", "", () => assert.equal(Knob.optionalInteger("PLURNK_TEST_OPTIONAL", 1), null, "a commented declaration leaves the key empty"));
    withEnv("PLURNK_TEST_OPTIONAL", "40", () => assert.equal(Knob.optionalInteger("PLURNK_TEST_OPTIONAL", 1), 40));
    withEnv("PLURNK_TEST_OPTIONAL", "0", () => assert.throws(() => Knob.optionalInteger("PLURNK_TEST_OPTIONAL", 1), ConfigurationError));
});


test("{§env-knob} a family reads every non-empty member of a prefix, in alias order", () => {
    const env = { FAM_b: "two", FAM_a: " one ", FAM_c: "", FAMILY: "not a member", OTHER_x: "no" };
    assert.deepEqual(Knob.family("FAM_", env), [{ alias: "a", value: "one" }, { alias: "b", value: "two" }]);
    assert.deepEqual(Knob.family("NONE_", env), [], "a family with no members is the empty list");
});
