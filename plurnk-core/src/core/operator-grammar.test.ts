// {§operator-grammar}
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
    assert.equal(resolveOperatorGrammarPath("custom.gbnf"), resolve("custom.gbnf"));
});
