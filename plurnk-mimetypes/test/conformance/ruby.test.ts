import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

const SOURCE = `require "json"
require_relative "./helper"

module Reporting
  class Parser < Base
    include Comparable

    def parse(text)
      h = Helper.new
      h.run(text)
      tokenize(text)
      Util::Cache.new
    end
  end
end

class Helper
  def run(x)
    inner(x)
  end
end

def tokenize(s)
  inner(s)
end

DECOY = "StringDecoy() should never surface"
# CommentDecoy() should never surface
`;

describe("conformance: text/x-ruby defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-ruby",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // Helper.new inside Reporting::Parser#parse joins to the
                // local class Helper — the service's (container, name) edge.
                { refName: "Helper", container: "Reporting.Parser.parse" },
                { refName: "tokenize", container: "Reporting.Parser.parse" },
            ],
            expectRefs: [
                { name: "Base", kind: "inherit", line: 5, container: "Reporting.Parser" },
                { name: "Comparable", kind: "inherit", line: 6, container: "Reporting.Parser" },
                { name: "Helper", kind: "instantiate", line: 9, container: "Reporting.Parser.parse" },
                { name: "run", kind: "call", line: 10, container: "Reporting.Parser.parse" },
                { name: "tokenize", kind: "call", line: 11, container: "Reporting.Parser.parse" },
                // Scope-qualified receiver: only the trailing constant.
                { name: "Cache", kind: "instantiate", line: 12, container: "Reporting.Parser.parse" },
                { name: "inner", kind: "call", line: 19, container: "Helper.run" },
                { name: "inner", kind: "call", line: 24, container: "tokenize" },
            ],
        });
        // require/require_relative take path strings — no import refs, and
        // the mechanism names never surface as calls.
        assert.ok(!references.some((r) => r.kind === "import"), "ruby emits no import refs");
        assert.ok(!references.some((r) => r.name === "require" || r.name === "require_relative"));
        // Classified-elsewhere method names never double as call refs.
        assert.ok(!references.some((r) => r.name === "new"), "'new' is instantiate, never call");
        assert.ok(!references.some((r) => r.name === "include"), "'include' args are inherit");
    });
});
