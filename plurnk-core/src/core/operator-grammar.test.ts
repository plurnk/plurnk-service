// {§operator-grammar} — an operator's GBNF is a file path; the service ships no profile, so a
// bare name is refused by name rather than resolved against anything (#588).
import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveOperatorGrammarPath } from "./TurnRunner.ts";

test("{§operator-grammar}: absolute, home-relative, and working-directory-relative paths resolve to files", () => {
    assert.equal(resolveOperatorGrammarPath("/operator/rails/custom.gbnf"), "/operator/rails/custom.gbnf");
    assert.equal(resolveOperatorGrammarPath("~/.config/plurnk/local.gbnf"), resolve(homedir(), ".config/plurnk/local.gbnf"));
    assert.equal(resolveOperatorGrammarPath("./rails/custom.gbnf"), resolve("rails/custom.gbnf"));
    assert.equal(resolveOperatorGrammarPath("rails/custom.gbnf"), resolve("rails/custom.gbnf"));
});

test("{§operator-grammar}: a bare profile name is an error that says the service ships none", () => {
    assert.throws(() => resolveOperatorGrammarPath("plurnk.qwen.gbnf"), {
        message: "PLURNK_PROVIDERS_GBNF=plurnk.qwen.gbnf names a bundled grammar profile; the service ships none (#588). Give the path of a grammar file you wrote.",
    });
});
