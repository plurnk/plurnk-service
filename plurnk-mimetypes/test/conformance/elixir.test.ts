import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

const SOURCE = `defmodule Reporting.Parser do
  use GenServer
  alias Reporting.Helper
  alias Reporting.Util.Cache, as: C
  require Logger

  def parse(text) do
    h = %Helper{name: text}
    Helper.run(h)
    tokenize(text)
    Logger.info("hi")
  end

  def tokenize(s) when is_binary(s) do
    inner(s)
  end
end

defmodule Helper do
  def run(x) do
    inner(x)
  end
end

# CommentDecoy() should never surface
decoy = "StringDecoy() should never surface"
`;

describe("conformance: text/x-elixir defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-elixir",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // tokenize(text) inside Reporting.Parser.parse joins to the
                // sibling def — the service's (container, name) edge.
                { refName: "tokenize", container: "Reporting.Parser.parse" },
                // Helper.run(h) joins to def run in the local Helper module.
                { refName: "run", container: "Reporting.Parser.parse" },
                // %Helper{} struct literal joins to the local Helper module.
                { refName: "Helper", container: "Reporting.Parser.parse" },
            ],
            expectRefs: [
                // `use` is macro injection — elixir's inheritance analog.
                { name: "GenServer", kind: "inherit", line: 2, container: "Reporting.Parser" },
                // Dotted module names verbatim — joins on the dotted def name.
                { name: "Reporting.Helper", kind: "import", line: 3, container: "Reporting.Parser" },
                // `as:` rebind captures the ORIGINAL alias, not C.
                { name: "Reporting.Util.Cache", kind: "import", line: 4, container: "Reporting.Parser" },
                { name: "Logger", kind: "import", line: 5, container: "Reporting.Parser" },
                { name: "Helper", kind: "instantiate", line: 8, container: "Reporting.Parser.parse" },
                // Remote dot call captures the function identifier.
                { name: "run", kind: "call", line: 9, container: "Reporting.Parser.parse" },
                { name: "tokenize", kind: "call", line: 10, container: "Reporting.Parser.parse" },
                { name: "info", kind: "call", line: 11, container: "Reporting.Parser.parse" },
                // Guard call right of `when` in the def header.
                { name: "is_binary", kind: "call", line: 14, container: "Reporting.Parser.tokenize" },
                { name: "inner", kind: "call", line: 15, container: "Reporting.Parser.tokenize" },
                { name: "inner", kind: "call", line: 21, container: "Helper.run" },
            ],
        });
        // Def headers are call nodes in elixir's uniform syntax — they must
        // never surface as refs (positional anchoring, not tags.scm-style
        // def-over-ref suppression).
        assert.ok(!references.some((r) => r.name === "parse"), "def header 'parse' is not a ref");
        assert.ok(!references.some((r) => r.kind === "call" && r.name === "tokenize" && r.line === 14));
        // The macro keyword family never surfaces as calls.
        for (const kw of ["def", "defmodule", "alias", "import", "require", "use"]) {
            assert.ok(!references.some((r) => r.name === kw), `'${kw}' never surfaces`);
        }
        // The `as:` rebind name is not emitted — the original alias is.
        assert.ok(!references.some((r) => r.name === "C"), "as: rebind captures the original");
        // use'd modules are inherit, never import.
        assert.ok(!references.some((r) => r.kind === "import" && r.name === "GenServer"));
    });
});
