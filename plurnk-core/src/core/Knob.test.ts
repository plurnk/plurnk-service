import test from "node:test";
import assert from "node:assert/strict";
import Knob from "./Knob.ts";

const withEnv = (name: string, value: string | undefined, body: () => void): void => {
    const prior = process.env[name];
    try {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
        body();
    } finally {
        if (prior === undefined) delete process.env[name]; else process.env[name] = prior;
    }
};

test("{§operator-config-only-home} a knob is the panel's value, read from the system environment", () => {
    withEnv("PLURNK_TEST_KNOB", "7", () => assert.equal(Knob.integer("PLURNK_TEST_KNOB", 0), 7));
    withEnv("PLURNK_TEST_KNOB", "-1", () => assert.equal(Knob.integer("PLURNK_TEST_KNOB", -1), -1, "a sentinel the floor admits is a value"));
    withEnv("PLURNK_TEST_KNOB", " a, b ,,c ", () => assert.deepEqual(Knob.list("PLURNK_TEST_KNOB"), ["a", "b", "c"]));
    withEnv("PLURNK_TEST_KNOB", "", () => assert.deepEqual(Knob.list("PLURNK_TEST_KNOB"), [], "the panel's empty value is the empty list"));
    withEnv("PLURNK_TEST_KNOB", "1", () => assert.equal(Knob.flag("PLURNK_TEST_KNOB"), true));
    withEnv("PLURNK_TEST_KNOB", "0", () => assert.equal(Knob.flag("PLURNK_TEST_KNOB"), false));
    withEnv("PLURNK_TEST_KNOB", "reject", () => assert.equal(Knob.choice("PLURNK_TEST_KNOB", ["accept", "reject"]), "reject"));
});

test("{§operator-config-only-home} an unset key is a broken floor and an invalid one is the operator's mistake: both crash by name", () => {
    withEnv("PLURNK_TEST_KNOB", undefined, () => {
        assert.throws(() => Knob.text("PLURNK_TEST_KNOB"), /PLURNK_TEST_KNOB is missing from the assembled environment floor/);
        assert.throws(() => Knob.integer("PLURNK_TEST_KNOB", 0), /missing from the assembled environment floor/);
    });
    for (const bad of ["banana", "", " ", "1.5", "9007199254740993"]) {
        withEnv("PLURNK_TEST_KNOB", bad, () => assert.throws(() => Knob.integer("PLURNK_TEST_KNOB", 0), /PLURNK_TEST_KNOB must be a safe integer of at least 0/, JSON.stringify(bad)));
    }
    // A bound limits what the operator may say; it is never a value used in the operator's place.
    withEnv("PLURNK_TEST_KNOB", "0", () => assert.throws(() => Knob.integer("PLURNK_TEST_KNOB", 1), /at least 1; got "0"/));
    for (const bad of ["", "true", "yes", "2", " 1"]) {
        withEnv("PLURNK_TEST_KNOB", bad, () => assert.throws(() => Knob.flag("PLURNK_TEST_KNOB"), /PLURNK_TEST_KNOB must be 0 or 1; got /, JSON.stringify(bad)));
    }
    withEnv("PLURNK_TEST_KNOB", "review", () => assert.throws(
        () => Knob.choice("PLURNK_TEST_KNOB", ["accept", "reject"]),
        /PLURNK_TEST_KNOB must be one of accept, reject; got "review"/,
    ));
});

test("{§operator-config-only-home} no reader accepts a value: a default cannot be written at a read", () => {
    assert.equal(Knob.text.length, 1);
    assert.equal(Knob.list.length, 1);
    assert.equal(Knob.integer.length, 2, "a name and a bound, and nothing that could stand in for the panel");
    assert.equal(Knob.flag.length, 1);
    assert.equal(Knob.choice.length, 2, "a name and a vocabulary, and nothing that could stand in for the panel");
});
