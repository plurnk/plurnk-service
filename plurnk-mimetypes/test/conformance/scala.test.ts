import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

const SOURCE = `package demo

import scala.collection.mutable.ListBuffer
import scala.util.{Try, Success => Win, Failure}
import scala.collection.immutable._

trait Runnable {
  def run(): Unit
}

class Helper(val size: Int) extends Runnable {
  def run(): Unit = println(size)
}

object Registry extends Helper(1) with Runnable {
  val shape: Shape = new Shape()
  var buf: ListBuffer[Token] = new ListBuffer[Token]()
  def parse(input: String): Token = {
    val h = new Helper(2)
    h.run()
    tokenize(input)
  }
  def tokenize(s: String): Token = Token(s)
}

class Shape
case class Token(text: String)

val decoy = "StringDecoy() should never surface"
// CommentDecoy() should never surface
`;

describe("conformance: text/x-scala defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-scala",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // new Helper(2) inside Registry.parse joins to the local
                // class Helper — exactly the service's (container, name) edge.
                { refName: "Helper", container: "Registry.parse" },
                { refName: "tokenize", container: "Registry.parse" },
                // Bare apply Token(s) classifies as call and still joins to
                // the local case class Token.
                { refName: "Token", container: "Registry.tokenize" },
            ],
            expectRefs: [
                // Plain import: FINAL path segment only.
                { name: "ListBuffer", kind: "import", line: 3 },
                // Selector list: each leaf; rename captures the ORIGINAL.
                { name: "Try", kind: "import", line: 4 },
                { name: "Success", kind: "import", line: 4 },
                { name: "Failure", kind: "import", line: 4 },
                { name: "Runnable", kind: "inherit", line: 11, container: "Helper" },
                // extends parent AND `with` mixin both inherit.
                { name: "Helper", kind: "inherit", line: 15, container: "Registry" },
                { name: "Runnable", kind: "inherit", line: 15, container: "Registry" },
                { name: "Shape", kind: "type", line: 16, container: "Registry.shape" },
                { name: "Shape", kind: "instantiate", line: 16, container: "Registry.shape" },
                // Generic head only: new ListBuffer[Token]() → ListBuffer.
                { name: "ListBuffer", kind: "instantiate", line: 17, container: "Registry.buf" },
                { name: "Token", kind: "type", line: 18, container: "Registry.parse" },
                { name: "Helper", kind: "instantiate", line: 19, container: "Registry.parse" },
                { name: "run", kind: "call", line: 20, container: "Registry.parse" },
                { name: "tokenize", kind: "call", line: 21, container: "Registry.parse" },
                { name: "Token", kind: "call", line: 23, container: "Registry.tokenize" },
            ],
        });
        // Wildcard import binds no nameable symbol — line 5 emits nothing.
        assert.equal(references.some((r) => r.line === 5), false);
        // The rename TARGET (Win) never surfaces; only the original does.
        assert.equal(references.some((r) => r.name === "Win"), false);
    });
});
