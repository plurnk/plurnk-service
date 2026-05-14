import test from "node:test";
import assert from "node:assert/strict";
import { CharStream, CommonTokenStream } from "antlr4ng";
import { plurnkLexer } from "../../src/generated/plurnkLexer.ts";
import { plurnkParser } from "../../src/generated/plurnkParser.ts";

test("toolchain smoke: placeholder grammar parses 'x'", () => {
  const input = CharStream.fromString("x");
  const lexer = new plurnkLexer(input);
  const tokens = new CommonTokenStream(lexer);
  const parser = new plurnkParser(tokens);
  const tree = parser.start();
  assert.ok(tree, "parser produced a tree");
  assert.equal(tree.getText(), "x", "tree text matches input");
});
