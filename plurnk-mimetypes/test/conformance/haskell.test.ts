import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";

// NOTE: the haskell.ts mapping is mostly FLAT, but a function def's span
// covers its signature AND all body equations (issue #22) — refs inside
// function bodies carry the function as container. Type refs on declaration
// lines join the same way: signature types inside a function/method def's
// span, and field/RHS types inside a data/newtype/synonym def's span.
const SOURCE = `module Main where

import Data.List (sort, nub)
import Data.Map (Map, insert)
import qualified Data.Map as Map

data Shape = Circle Double | Rect Double Double

data Point = Point { px :: Double, py :: Double }

newtype Token = Token String

type Result = Either String Token

class Renderer a where
  render :: a -> String
  describe :: a -> Token

instance Renderer Shape where
  render (Circle r) = "circle"
  render _ = "rect"
  describe _ = Token "shape"

tokenize :: String -> Token
tokenize s = Token (sort s)

process :: Shape -> Result
process sh = Right (tokenize (render sh))

collect :: [Token] -> (Token, Shape) -> Map String Token
collect ts pair = Map.insert "k" (nub ts) Map.empty

decoy :: String
decoy = "StringDecoy should never surface"
-- CommentDecoy should never surface
`;

describe("conformance: text/x-haskell defs + refs (issues #19/#20)", () => {
    it("passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-haskell",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // Token in the type synonym RHS joins to the local newtype —
                // the ref sits on the synonym def's own line.
                { refName: "Token", container: "Result" },
                // Token in describe's class-body signature joins via the
                // method's qualified path (class container on the def).
                { refName: "Token", container: "Renderer.describe" },
                // Shape/Result in process's signature join to local defs.
                { refName: "Shape", container: "process" },
                { refName: "Result", container: "process" },
                // Body CALL refs join at function level now that the def's
                // span covers the equations (issue #22).
                { refName: "tokenize", container: "process" },
                { refName: "render", container: "process" },
            ],
            expectRefs: [
                { name: "sort", kind: "import", line: 3 },
                { name: "nub", kind: "import", line: 3 },
                { name: "Map", kind: "import", line: 4 },
                { name: "insert", kind: "import", line: 4 },
                { name: "Double", kind: "type", line: 7, container: "Shape" },
                { name: "String", kind: "type", line: 11, container: "Token" },
                { name: "Either", kind: "type", line: 13, container: "Result" },
                { name: "String", kind: "type", line: 16, container: "Renderer.render" },
                { name: "Renderer", kind: "inherit", line: 19 },
                // Instance target type — the type the class is implemented for.
                { name: "Shape", kind: "type", line: 19 },
                { name: "Token", kind: "type", line: 24, container: "tokenize" },
                // Body refs carry the enclosing function (issue #22).
                { name: "sort", kind: "call", line: 25, container: "tokenize" },
                { name: "tokenize", kind: "call", line: 28, container: "process" },
                { name: "render", kind: "call", line: 28, container: "process" },
                // List/tuple element types in collect's signature.
                { name: "Token", kind: "type", line: 30, container: "collect" },
                { name: "Shape", kind: "type", line: 30, container: "collect" },
                // Qualified call captures the name side (Map.insert → insert).
                { name: "insert", kind: "call", line: 31, container: "collect" },
                { name: "nub", kind: "call", line: 31, container: "collect" },
            ],
        });
        // Module names are dotted paths, not name-joinable symbols — the
        // bare and qualified imports (lines 5) emit nothing, and no module
        // segment ever surfaces.
        assert.ok(!references.some((r) => r.kind === "import" && r.line === 5));
        assert.ok(!references.some((r) => r.name === "Data" || r.name === "Data.List" || r.name === "Data.Map"));
        // Constructor application is NOT instantiate (pattern/expression
        // ambiguity — see queries/haskell.ts).
        assert.ok(!references.some((r) => r.kind === "instantiate"));
        // Pattern deconstruction heads never surface as calls.
        assert.ok(!references.some((r) => r.name === "Circle" && r.kind === "call"));
    });
});
