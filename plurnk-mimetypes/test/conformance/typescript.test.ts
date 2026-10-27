import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";
import TreeSitterLanguageHandler from "../../src/treesitter/handler.ts";
import { lookupTreeSitterLanguage } from "../../src/treesitter/registry.ts";

// ─── typescript.test.ts ───
{
const SOURCE = `import { Helper, type Shape } from "./helper";
import Default, { Other as O } from "./default";

export class Parser extends Base implements Runnable {
    field: Shape;
    parse(input: string): Token {
        const h = new Helper();
        h.run(input);
        return tokenize(input);
    }
}
class Helper {
    run(x: string): void { decoyFree(x); }
}
function tokenize(s: string): Token { return inner(s); }
const decoy = "StringDecoy() should never surface";
// CommentDecoy() should never surface
`;

describe("{§mimetype-references} conformance: text/typescript defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/typescript",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // new Helper() inside Parser.parse joins to the local class
                // Helper — exactly the service's (container, name) edge.
                { refName: "Helper", container: "Parser.parse" },
                { refName: "tokenize", container: "Parser.parse" },
            ],
            expectRefs: [
                { name: "Helper", kind: "import", line: 1 },
                { name: "Shape", kind: "import", line: 1 },
                { name: "Default", kind: "import", line: 2 },
                { name: "Other", kind: "import", line: 2 },
                { name: "Base", kind: "inherit", line: 4 },
                { name: "Runnable", kind: "inherit", line: 4 },
                { name: "Shape", kind: "type", line: 5, container: "Parser.field" },
                { name: "Token", kind: "type", line: 6 },
                { name: "Helper", kind: "instantiate", line: 7, container: "Parser.parse" },
                { name: "run", kind: "call", line: 8, container: "Parser.parse" },
                { name: "tokenize", kind: "call", line: 9, container: "Parser.parse" },
                { name: "inner", kind: "call", line: 15, container: "tokenize" },
            ],
        });
        // Container precision: refs at class-body level vs method level.
        const fieldType = references.find((r) => r.name === "Shape" && r.line === 5);
        assert.equal(fieldType?.container, "Parser.field");
    });
});
}

// ─── bash.test.ts ───
{
// bash.ts is FLAT (function defs carry no container), so a call's container is
// the bare name of the enclosing function def (its body span); top-level
// commands have none. Local function calls join; external commands are dead
// rows by design.
const SOURCE = `#!/usr/bin/env bash
# deploy helper script

greet() {
  echo "hello there"
}

main() {
  greet world
  log_message "starting up"
}

log_message() {
  printf '%s\\n' "$1"
}

main
`;

describe("{§mimetype-references} conformance: text/x-shellscript refs", () => {
    it("{§mimetype-references} command calls join to local functions; externals are dead rows", async () => {
        await runConformance({
            mimetype: "text/x-shellscript",
            source: SOURCE,
            decoyNames: ["deploy", "hello", "there", "starting"],
            expectJoins: [
                { refName: "greet", container: "main" },
                { refName: "log_message", container: "main" },
            ],
            expectRefs: [
                { name: "greet", kind: "call" },
                { name: "echo", kind: "call" },
                { name: "main", kind: "call" },
            ],
        });
    });
});
}

// ─── c.test.ts ───
{
// NOTE: the c.ts mapping is FLAT except enum bodies (enumerators carry the
// enum name as container), so ref containers are the bare names of the
// enclosing function/struct/typedef defs by line containment.
const SOURCE = `#include <stdio.h>
#include "local.h"

struct Shape { int w; };
enum Color { RED, GREEN };
typedef struct Shape ShapeT;
typedef int Token;

struct Holder {
    ShapeT inner;
    struct Shape raw;
};

Token tokenize(const char *s, struct Shape sh) {
    printf("StringDecoy() %s", s);
    return 0;
}

ShapeT *make_shape(Token t, enum Color c) {
    struct Shape local;
    ShapeT *p = (ShapeT *)0;
    Token tk = tokenize("x", local);
    helper(tk);
    return p;
}

void helper(Token t) {}
// CommentDecoy() never surfaces
`;

describe("{§mimetype-references} conformance: text/x-c defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-c",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // tokenize("x", local) inside make_shape joins to the local
                // function def — exactly the service's (container, name) edge.
                { refName: "tokenize", container: "make_shape" },
                { refName: "helper", container: "make_shape" },
                { refName: "Shape", container: "Holder" },
            ],
            expectRefs: [
                // typedef underlying tag use; the typedef def spans its own
                // line, so it is the innermost container for the ref.
                { name: "Shape", kind: "type", line: 6, container: "ShapeT" },
                { name: "ShapeT", kind: "type", line: 10, container: "Holder" },
                { name: "Shape", kind: "type", line: 11, container: "Holder" },
                // Return type and tagged param of tokenize.
                { name: "Token", kind: "type", line: 14, container: "tokenize" },
                { name: "Shape", kind: "type", line: 14, container: "tokenize" },
                { name: "printf", kind: "call", line: 15, container: "tokenize" },
                { name: "ShapeT", kind: "type", line: 19, container: "make_shape" },
                { name: "Color", kind: "type", line: 19, container: "make_shape" },
                { name: "Shape", kind: "type", line: 20, container: "make_shape" },
                // Declaration type AND cast type_descriptor on one line.
                { name: "ShapeT", kind: "type", line: 21, column: 5 },
                { name: "ShapeT", kind: "type", line: 21, column: 18 },
                { name: "tokenize", kind: "call", line: 22, container: "make_shape" },
                { name: "helper", kind: "call", line: 23, container: "make_shape" },
                { name: "Token", kind: "type", line: 27, container: "helper" },
            ],
        });
        // #include takes path strings, not symbol names — no import refs
        // for C ({§mimetype-references} bans path strings from the refs channel).
        assert.ok(!references.some((r) => r.kind === "import"), "no import refs for C");
        assert.ok(!references.some((r) => r.name === "stdio.h" || r.name === "local.h"));
    });
});
}

// ─── cpp.test.ts ───
{
const SOURCE = `#include <vector>
using std::vector;
using namespace std;

namespace geo {

class Shape {
public:
    virtual double area();
    int sides;
};

class Circle : public Shape, private util::Tagged {
public:
    double radius;
    double area() {
        return compute(radius);
    }
    Shape* duplicate() {
        Shape* copy = new Circle();
        copy->resize();
        return copy;
    }
};

double compute(double r, vector<double> samples) {
    return helper::square(r);
}

}

int main() {
    geo::Circle c;
    double a = c.area();
    Box b = Box{};
    return 0;
}

const char* DECOY = "StringDecoy() should never surface";
// CommentDecoy() should never surface
`;

describe("{§mimetype-references} conformance: text/x-cpp defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-cpp",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // compute called from Circle::area joins to the namespace-level
                // function — the cpp mapping emits namespace containers, so
                // method scopes are geo.Circle.<method>.
                { refName: "compute", container: "geo.Circle.area" },
                { refName: "Circle", container: "geo.Circle.duplicate" },
                { refName: "Shape", container: "geo.Circle.duplicate" },
                { refName: "area", container: "main" },
            ],
            expectRefs: [
                // `using std::vector` captures the bound final identifier.
                { name: "vector", kind: "import", line: 2 },
                // Base-class refs sit on the class's own def line, so their
                // container is the class itself (innermost enclosing def).
                { name: "Shape", kind: "inherit", line: 13, container: "geo.Circle" },
                // Qualified base captures the final segment only.
                { name: "Tagged", kind: "inherit", line: 13, container: "geo.Circle" },
                { name: "compute", kind: "call", line: 17, container: "geo.Circle.area" },
                // Return type of duplicate().
                { name: "Shape", kind: "type", line: 19, container: "geo.Circle.duplicate" },
                // Local declaration type.
                { name: "Shape", kind: "type", line: 20, container: "geo.Circle.duplicate" },
                { name: "Circle", kind: "instantiate", line: 20, container: "geo.Circle.duplicate" },
                // Arrow-call method name.
                { name: "resize", kind: "call", line: 21, container: "geo.Circle.duplicate" },
                // Template head in a parameter type; arguments stay out.
                { name: "vector", kind: "type", line: 26, container: "geo.compute" },
                // Qualified call captures the final segment.
                { name: "square", kind: "call", line: 27, container: "geo.compute" },
                // Qualified local type captures the final segment.
                { name: "Circle", kind: "type", line: 33, container: "main" },
                { name: "area", kind: "call", line: 34, container: "main" },
                { name: "Box", kind: "type", line: 35, container: "main" },
                // Compound-literal construction.
                { name: "Box", kind: "instantiate", line: 35, container: "main" },
            ],
        });
        // Scope qualifiers and `using namespace` never surface — only final
        // segments and bound names.
        for (const scope of ["std", "geo", "util", "helper"]) {
            assert.ok(
                !references.some((r) => r.name === scope),
                `scope qualifier "${scope}" surfaced as a ref`,
            );
        }
        // No bare identifier reads.
        for (const bare of ["copy", "radius", "r", "c", "a", "b"]) {
            assert.ok(
                !references.some((r) => r.name === bare),
                `bare identifier read "${bare}" surfaced as a ref`,
            );
        }
    });
});
}

// ─── dart.test.ts ───
{
// tree-sitter-dart parses bodies as siblings of their signatures; the
// extractor extends each def's span over the sibling function_body
// ({§mimetype-references}), so refs inside multi-line bodies join at method level.
const SOURCE = `import 'package:demo/helper.dart' show Helper, Shape hide Junk;
import 'dart:math';

class Parser extends Base with Mixy implements Runnable {
  Shape field;
  final List<Token> tokens = [];
  Token parse(String input) {
    return tokenize(input);
  }
  void build() {
    final h = new Helper();
    final p = const Point(1, 2);
    h.run(field);
  }
}
class Helper {
  void run(Shape x) {
    decoyFree(x);
  }
}
mixin Mixy on Base {}
enum Color { red, green }
Token tokenize(String s) {
  return inner(s);
}
void main() {
  Shape s = make();
  s?.draw();
}
const decoy = "StringDecoy() should never surface";
// CommentDecoy() should never surface
`;

describe("{§mimetype-references} conformance: text/x-dart defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-dart",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // tokenize(input) inside Parser.parse's multi-line body joins
                // to the local function tokenize — exactly the service's
                // (container, name) edge.
                { refName: "tokenize", container: "Parser.parse" },
                { refName: "Helper", container: "Parser.build" },
                { refName: "Mixy", container: "Parser" },
            ],
            expectRefs: [
                { name: "Helper", kind: "import", line: 1 },
                { name: "Shape", kind: "import", line: 1 },
                { name: "Base", kind: "inherit", line: 4, container: "Parser" },
                { name: "Mixy", kind: "inherit", line: 4, container: "Parser" },
                { name: "Runnable", kind: "inherit", line: 4, container: "Parser" },
                { name: "Shape", kind: "type", line: 5, container: "Parser.field" },
                { name: "List", kind: "type", line: 6, container: "Parser.tokens" },
                { name: "Token", kind: "type", line: 6, container: "Parser.tokens" },
                { name: "Token", kind: "type", line: 7, container: "Parser.parse" },
                { name: "String", kind: "type", line: 7, container: "Parser.parse" },
                { name: "tokenize", kind: "call", line: 8, container: "Parser.parse" },
                { name: "Helper", kind: "instantiate", line: 11, container: "Parser.build" },
                { name: "Point", kind: "instantiate", line: 12, container: "Parser.build" },
                { name: "run", kind: "call", line: 13, container: "Parser.build" },
                { name: "decoyFree", kind: "call", line: 18, container: "Helper.run" },
                { name: "Base", kind: "inherit", line: 21, container: "Mixy" },
                { name: "inner", kind: "call", line: 24, container: "tokenize" },
                { name: "Shape", kind: "type", line: 27, container: "main" },
                { name: "make", kind: "call", line: 27, container: "main" },
                { name: "draw", kind: "call", line: 28, container: "main" },
            ],
        });
        // hide combinator names are explicitly unbound — never imports.
        assert.ok(!references.some((r) => r.name === "Junk"), "hide name must not surface");
        // Bare reads stay out: argument identifiers are not refs.
        assert.ok(
            !references.some((r) => r.name === "field" && r.line === 13),
            "argument identifier surfaced as a ref",
        );
    });
});
}

// ─── elixir.test.ts ───
{
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

describe("{§mimetype-references} conformance: text/x-elixir defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
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
}

// ─── fsharp-signature.test.ts ───
{
it("{§mimetype-references} conformance: F# signatures project imports and types without implementation-only query nodes", async () => {
    const { references } = await runConformance({
        mimetype: "text/x-fsharp-signature",
        source: `module Geometry.Core
open System.Collections
open Helpers
type Shape = { Width: int; Height: int }
type Runnable =
    abstract member Run: Shape -> int
val area: shape: Shape -> int
// CommentDecoy should never surface
`,
        decoyNames: ["CommentDecoy"],
        expectJoins: [{ refName: "Shape", container: "Geometry.Core.Runnable.Run" }],
        expectRefs: [
            { name: "System.Collections", kind: "import", line: 2 },
            { name: "Helpers", kind: "import", line: 3 },
            { name: "int", kind: "type", line: 4 },
            { name: "Shape", kind: "type", line: 6, container: "Geometry.Core.Runnable.Run" },
            { name: "int", kind: "type", line: 6 },
            { name: "Shape", kind: "type", line: 7 },
            { name: "int", kind: "type", line: 7 },
        ],
    });
    assert.ok(references.every(({ kind }) => kind !== "call"), "signatures contain no executable call bodies");
});
}

// ─── fsharp.test.ts ───
{
// NOTE on containers: the fsharp mapping emits named modules, record/union
// types + their fields/cases, top-level let bindings, AND implicit-constructor
// types (anon_type_defn, `type Parser(...) =`) with their members ({§mimetype-references}).
// Refs inside member bodies resolve to the member's dotted path
// (Geometry.Core.Parser.Parse); refs in the type header (inherit/interface)
// resolve to the type itself (probed via extractRaw).
const SOURCE = `module Geometry.Core

open System.Collections
open Helpers

type Shape = { Width: int; Height: int }

type Color = Red | Green

type Runnable =
    abstract member Run: Shape -> int

type Parser(token: string) =
    inherit BaseParser()
    interface Runnable with
        member this.Run () = ignore token
    member this.Parse (input: string) : Shape =
        let h = Helper()
        let b = new BaseParser()
        h.Run input
        tokenize input

let tokenize (s: string) : Shape =
    inner s

let area (shape: Shape) : int =
    shape.Width * shape.Height

let decoy = "StringDecoy should never surface"
// CommentDecoy should never surface
`;

describe("{§mimetype-references} conformance: text/x-fsharp defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-fsharp",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // tokenize's return annotation names the local record Shape;
                // the ref sits inside the emitted def `tokenize`.
                { refName: "Shape", container: "Geometry.Core.tokenize" },
                { refName: "Shape", container: "Geometry.Core.area" },
                // Call inside Parser.Parse — anon_type_defn members are
                // emitted ({§mimetype-references}), so the ref joins at member level.
                { refName: "tokenize", container: "Geometry.Core.Parser.Parse" },
                // Interface clause names the local Runnable type; the ref
                // sits in Parser's header, inside the emitted Parser def.
                { refName: "Runnable", container: "Geometry.Core.Parser" },
            ],
            expectRefs: [
                // open captures the full dotted name — the mapping's
                // joinable module-def form.
                { name: "System.Collections", kind: "import", line: 3 },
                { name: "Helpers", kind: "import", line: 4 },
                { name: "int", kind: "type", line: 6 },
                // Member-signature annotation types — the abstract member is
                // itself an emitted def (anon_type_defn, {§mimetype-references}).
                { name: "Shape", kind: "type", line: 11, container: "Geometry.Core.Runnable.Run" },
                { name: "int", kind: "type", line: 11, container: "Geometry.Core.Runnable.Run" },
                { name: "BaseParser", kind: "inherit", line: 14, container: "Geometry.Core.Parser" },
                { name: "Runnable", kind: "inherit", line: 15, container: "Geometry.Core.Parser" },
                // Construction is syntactically application → call
                // (python precedent), with or without `new`.
                { name: "Helper", kind: "call", line: 18, container: "Geometry.Core.Parser.Parse" },
                { name: "BaseParser", kind: "call", line: 19, container: "Geometry.Core.Parser.Parse" },
                // Dotted application head → final name.
                { name: "Run", kind: "call", line: 20, container: "Geometry.Core.Parser.Parse" },
                { name: "tokenize", kind: "call", line: 21, container: "Geometry.Core.Parser.Parse" },
                { name: "inner", kind: "call", line: 24 },
                { name: "Shape", kind: "type", line: 26, container: "Geometry.Core.area" },
            ],
        });
        // Application arguments are the same node shape as heads — only the
        // anchored head surfaces (`tokenize input` must not emit `input`).
        assert.ok(!references.some((r) => r.name === "input"), "argument read leaked as ref");
        // Bare dotted reads (`shape.Width`) are not applications — no ref.
        assert.ok(
            !references.some((r) => r.name === "Width" && r.kind === "call"),
            "bare member read leaked as call",
        );
    });
});
}

// ─── go.test.ts ───
{
// NOTE: the go.ts mapping is FLAT (no containers on defs — methods don't
// carry receiver types), so ref containers are the bare names of the
// enclosing func/method/type defs.
const SOURCE = `package main

import (
	"fmt"
	alias "strings"
)

type Base struct{}

type Parser struct {
	Base
	field Shape
	count int
}

type Shape struct{ w int }

func (p *Parser) Parse(input string) Token {
	h := Helper{}
	h.Run(input)
	var s pkg.Other
	return Tokenize(input, s)
}

func Tokenize(s string, sh Shape) Token {
	fmt.Println(s)
	return inner(s)
}

type Token int
type Helper struct{}
func (h Helper) Run(x string) {}
func inner(x string) Token { return 0 }
const decoy = "StringDecoy() should never surface"
// CommentDecoy() should never surface
`;

describe("{§mimetype-references} conformance: text/x-go defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-go",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // Helper{} inside Parse joins to the local struct Helper —
                // exactly the service's (container, name) edge.
                { refName: "Helper", container: "Parse" },
                { refName: "Tokenize", container: "Parse" },
                { refName: "inner", container: "Tokenize" },
            ],
            expectRefs: [
                { name: "Base", kind: "inherit", line: 11, container: "Parser" },
                { name: "Shape", kind: "type", line: 12, container: "Parser" },
                // Pointer receiver type joins the method to its struct.
                { name: "Parser", kind: "type", line: 18, container: "Parse" },
                { name: "Token", kind: "type", line: 18, container: "Parse" },
                { name: "Helper", kind: "instantiate", line: 19, container: "Parse" },
                { name: "Run", kind: "call", line: 20, container: "Parse" },
                // Name side of qualified_type (pkg.Other).
                { name: "Other", kind: "type", line: 21, container: "Parse" },
                { name: "Tokenize", kind: "call", line: 22, container: "Parse" },
                { name: "Shape", kind: "type", line: 25, container: "Tokenize" },
                { name: "Println", kind: "call", line: 26, container: "Tokenize" },
                { name: "inner", kind: "call", line: 27, container: "Tokenize" },
                { name: "Helper", kind: "type", line: 32, container: "Run" },
            ],
        });
        // v1 decision: Go imports are package paths, not symbols — no
        // import refs, even for the aliased import.
        assert.ok(!references.some((r) => r.kind === "import"), "no import refs for Go");
        assert.ok(!references.some((r) => r.name === "alias" || r.name === "fmt"));
    });
});
}

// ─── haskell.test.ts ───
{
// NOTE: the haskell.ts mapping is mostly FLAT, but a function def's span
// covers its signature AND all body equations ({§mimetype-references}) — refs inside
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

describe("{§mimetype-references} conformance: text/x-haskell defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
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
                // span covers the equations ({§mimetype-references}).
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
                // Body refs carry the enclosing function ({§mimetype-references}).
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
        // ambiguity — see queries/haskell.scm).
        assert.ok(!references.some((r) => r.kind === "instantiate"));
        // Pattern deconstruction heads never surface as calls.
        assert.ok(!references.some((r) => r.name === "Circle" && r.kind === "call"));
    });
});
}

// ─── java.test.ts ───
{
const SOURCE = `import java.util.List;
import java.util.*;

public class Parser extends Base implements Runnable {
    private Shape field;
    private List<Token> tokens;
    private String decoy = "StringDecoy() should never surface";

    public Token parse(String input) {
        Helper h = new Helper();
        h.run(input);
        return tokenize(input);
    }

    Token tokenize(String s) {
        return inner(s);
    }
}

class Helper {
    void run(String x) { decoyFree(x); }
}

class Base {}
interface Runnable {}
class Shape {}
class Token {}
// CommentDecoy() should never surface
`;

describe("{§mimetype-references} conformance: text/x-java defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-java",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // new Helper() inside Parser.parse joins to the local class
                // Helper — exactly the service's (container, name) edge.
                { refName: "Helper", container: "Parser.parse" },
                { refName: "tokenize", container: "Parser.parse" },
                // Field type joins to the local class Shape.
                { refName: "Shape", container: "Parser.field" },
            ],
            expectRefs: [
                { name: "List", kind: "import", line: 1 },
                { name: "Base", kind: "inherit", line: 4 },
                { name: "Runnable", kind: "inherit", line: 4 },
                { name: "Shape", kind: "type", line: 5, container: "Parser.field" },
                { name: "List", kind: "type", line: 6, container: "Parser.tokens" },
                { name: "Token", kind: "type", line: 6, container: "Parser.tokens" },
                { name: "Token", kind: "type", line: 9, container: "Parser.parse" },
                { name: "String", kind: "type", line: 9, container: "Parser.parse" },
                { name: "Helper", kind: "type", line: 10, container: "Parser.parse" },
                { name: "Helper", kind: "instantiate", line: 10, container: "Parser.parse" },
                { name: "run", kind: "call", line: 11, container: "Parser.parse" },
                { name: "tokenize", kind: "call", line: 12, container: "Parser.parse" },
                { name: "inner", kind: "call", line: 16, container: "Parser.tokenize" },
                { name: "decoyFree", kind: "call", line: 21, container: "Helper.run" },
            ],
        });
        // Wildcard import emits nothing — no "util" ref from line 2.
        assert.ok(
            !references.some((r) => r.kind === "import" && r.name !== "List"),
            "only the bound symbol import surfaces; wildcard imports skip",
        );
    });
});
}

// ─── javascript.test.ts ───
{
const SOURCE = `import { Helper, Other as O } from "./helper";
import Default from "./default";

export class Parser extends Base {
    parse(input) {
        const h = new Helper();
        h.run(input);
        return tokenize(input);
    }
}
class Helper {
    run(x) { decoyFree(x); }
}
function tokenize(s) { return inner(s); }
const decoy = "StringDecoy() should never surface";
// CommentDecoy() should never surface
`;

describe("{§mimetype-references} conformance: text/javascript defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/javascript",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // new Helper() inside Parser.parse joins to the local class
                // Helper — exactly the service's (container, name) edge.
                { refName: "Helper", container: "Parser.parse" },
                { refName: "tokenize", container: "Parser.parse" },
            ],
            expectRefs: [
                { name: "Helper", kind: "import", line: 1 },
                { name: "Other", kind: "import", line: 1 },
                { name: "Default", kind: "import", line: 2 },
                { name: "Base", kind: "inherit", line: 4 },
                { name: "Helper", kind: "instantiate", line: 6, container: "Parser.parse" },
                { name: "run", kind: "call", line: 7, container: "Parser.parse" },
                { name: "tokenize", kind: "call", line: 8, container: "Parser.parse" },
                { name: "decoyFree", kind: "call", line: 12, container: "Helper.run" },
                { name: "inner", kind: "call", line: 14, container: "tokenize" },
            ],
        });
        // Aliased import captures the original exported name, not the alias.
        assert.ok(!references.some((r) => r.name === "O"));
        // Module-path strings never surface as refs.
        assert.ok(!references.some((r) => r.name.includes("./")));
    });
});
}

// ─── julia.test.ts ───
{
const SOURCE = `module Geometry

using LinearAlgebra
using Printf: @printf, format
import Statistics as Stats

abstract type AbstractShape end

struct Circle <: AbstractShape
    radius::Float64
    points::Vector{Point}
end

function area(c::Circle)::Float64
    return 3.14159 * c.radius * c.radius
end

function summarize(shapes)
    c = Circle(1.0, [])
    total = area(c)
    scaled = area.(shapes)
    m = Stats.mean(scaled)
    @printf("%.2f", total)
    return total + m
end

scale(c::Circle, k) = Circle(c.radius * k, c.points)

DECOY = "StringDecoy() should never surface"
# CommentDecoy() should never surface

end
`;

describe("{§mimetype-references} conformance: text/x-julia defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-julia",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // struct Circle <: AbstractShape joins to the local abstract
                // type — the inherit edge inside the Circle def's span.
                { refName: "AbstractShape", container: "Geometry.Circle" },
                // Circle(1.0, []) inside summarize joins to the local struct
                // (constructors are syntactically calls in Julia).
                { refName: "Circle", container: "Geometry.summarize" },
                { refName: "area", container: "Geometry.summarize" },
            ],
            expectRefs: [
                { name: "LinearAlgebra", kind: "import", line: 3 },
                // Selected imports: module AND bindings; @printf joins defs
                // channel convention (macro names without @).
                { name: "Printf", kind: "import", line: 4 },
                { name: "printf", kind: "import", line: 4 },
                { name: "format", kind: "import", line: 4 },
                // `as` rebind: the ORIGINAL name, never the alias.
                { name: "Statistics", kind: "import", line: 5 },
                { name: "AbstractShape", kind: "inherit", line: 9, container: "Geometry.Circle" },
                { name: "Float64", kind: "type", line: 10, container: "Geometry.Circle" },
                // Parametric field type: head and parameter.
                { name: "Vector", kind: "type", line: 11, container: "Geometry.Circle" },
                { name: "Point", kind: "type", line: 11, container: "Geometry.Circle" },
                // Signature annotations: param type and return type.
                { name: "Circle", kind: "type", line: 14, container: "Geometry.area" },
                { name: "Float64", kind: "type", line: 14, container: "Geometry.area" },
                { name: "Circle", kind: "call", line: 19, container: "Geometry.summarize" },
                { name: "area", kind: "call", line: 20, container: "Geometry.summarize" },
                // Broadcast call: area.(shapes).
                { name: "area", kind: "call", line: 21, container: "Geometry.summarize" },
                // Qualified call: Stats.mean → mean.
                { name: "mean", kind: "call", line: 22, container: "Geometry.summarize" },
                // Macro invocation: @printf → printf.
                { name: "printf", kind: "call", line: 23, container: "Geometry.summarize" },
                // Short-form def line: LHS param type + RHS constructor call.
                { name: "Circle", kind: "type", line: 27, container: "Geometry.scale" },
                { name: "Circle", kind: "call", line: 27, container: "Geometry.scale" },
            ],
        });
        // `import Statistics as Stats` — the alias must not surface.
        assert.ok(!references.some((r) => r.name === "Stats"), "alias 'Stats' must not surface");
        // Def-shaped heads are not uses: `function area(c)` (signature call)
        // and `scale(c, k) = ...` (assignment-LHS call) emit no call refs.
        assert.ok(
            !references.some((r) => r.name === "area" && r.kind === "call" && r.line === 14),
            "function signature callee must not surface as a call",
        );
        assert.ok(
            !references.some((r) => r.name === "scale"),
            "short-form definition head must not surface",
        );
    });
});
}

// ─── kotlin.test.ts ───
{
const SOURCE = `package com.example

import com.example.util.Formatter
import com.example.util.Tokenizer as T
import com.example.other.*

class Parser(val shape: Shape) : Base(), Runnable {
    val field: Shape = makeShape()
    val items: List<Token> = listOf()
    fun parse(input: String): Token {
        val h = Helper()
        h.run(input)
        return tokenize(input)
    }
}
class Helper {
    fun run(x: String) { decoyFree(x) }
}
fun tokenize(s: String): Token? = inner(s)
val decoy = "StringDecoy() should never surface"
// CommentDecoy() should never surface
`;

describe("{§mimetype-references} conformance: text/x-kotlin defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-kotlin",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // Helper() inside Parser.parse joins to the local class
                // Helper — constructor invocation is a call in Kotlin
                // (queries/kotlin.scm header), and the join still lands.
                { refName: "Helper", container: "Parser.parse" },
                { refName: "tokenize", container: "Parser.parse" },
            ],
            expectRefs: [
                { name: "Formatter", kind: "import", line: 3 },
                // Aliased import captures the ORIGINAL name, not the alias.
                { name: "Tokenizer", kind: "import", line: 4 },
                { name: "Shape", kind: "type", line: 7, container: "Parser" },
                { name: "Base", kind: "inherit", line: 7 },
                { name: "Runnable", kind: "inherit", line: 7 },
                { name: "Shape", kind: "type", line: 8, container: "Parser.field" },
                // Generic property type yields both outer and argument names.
                { name: "List", kind: "type", line: 9, container: "Parser.items" },
                { name: "Token", kind: "type", line: 9, container: "Parser.items" },
                { name: "Token", kind: "type", line: 10, container: "Parser.parse" },
                { name: "Helper", kind: "call", line: 11, container: "Parser.parse" },
                { name: "run", kind: "call", line: 12, container: "Parser.parse" },
                { name: "tokenize", kind: "call", line: 13, container: "Parser.parse" },
                { name: "decoyFree", kind: "call", line: 17, container: "Helper.run" },
                // Nullable return type (Token?) still yields the type name.
                { name: "Token", kind: "type", line: 19, container: "tokenize" },
                { name: "inner", kind: "call", line: 19, container: "tokenize" },
            ],
        });
        // Wildcard import (`import com.example.other.*`) must not surface —
        // its trailing package segment is not a bindable symbol name.
        assert.ok(!references.some((r) => r.kind === "import" && r.line === 5));
        // Aliased import: the alias binding `T` never surfaces as a ref.
        assert.ok(!references.some((r) => r.name === "T"));
        // Container precision: refs at class-body level vs method level.
        const fieldType = references.find((r) => r.name === "Shape" && r.line === 8);
        assert.equal(fieldType?.container, "Parser.field");
    });
});
}

// ─── lua.test.ts ───
{
// NOTE: the lua.ts mapping is FLAT (top-level walk only — function/method
// defs carry no containers), so ref containers are the bare names of the
// enclosing function defs (helper/process/run).
const SOURCE = `local M = {}

local function helper(x)
  return x + 1
end

function M.process(input)
  local v = helper(input)
  M.finish(v)
  return v
end

function M:run(input)
  local r = M.process(helper(input))
  self:emit(r)
  obj.mod.deep(r)
  print(r)
  local lib = require("some.lib")
  return lib
end

setmetatable(M, { __index = Base })
local s = "StringDecoy() should never surface"
-- CommentDecoy() should never surface
`;

describe("{§mimetype-references} conformance: text/x-lua defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-lua",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // helper(input) inside M.process joins to the local function
                // helper — exactly the service's (container, name) edge.
                { refName: "helper", container: "process" },
                { refName: "process", container: "run" },
                { refName: "helper", container: "run" },
            ],
            expectRefs: [
                { name: "helper", kind: "call", line: 8, container: "process" },
                // Dotted call: M.finish(v) → field name.
                { name: "finish", kind: "call", line: 9, container: "process" },
                // Dotted call to a sibling def: M.process(...) → process.
                { name: "process", kind: "call", line: 14, container: "run" },
                { name: "helper", kind: "call", line: 14, container: "run" },
                // Method call: self:emit(r) → method name.
                { name: "emit", kind: "call", line: 15, container: "run" },
                // Chained dotted call: obj.mod.deep(r) → final field.
                { name: "deep", kind: "call", line: 16, container: "run" },
                { name: "print", kind: "call", line: 17, container: "run" },
                // Top-level call has no container.
                { name: "setmetatable", kind: "call", line: 22 },
            ],
        });
        // v1 decisions: require() takes a path string — no import refs;
        // metatable inheritance is dynamic — no inherit refs; Lua has no
        // types or constructors — no type/instantiate refs.
        assert.ok(references.every((r) => r.kind === "call"), "lua emits only call refs");
        assert.ok(!references.some((r) => r.name === "require"), "require is the import mechanism, not a call ref");
        assert.ok(!references.some((r) => r.name === "Base"), "metatable __index value is not an inherit ref");
    });
});
}

// ─── make.test.ts ───
{
const SOURCE = `CC := gcc
OBJS = main.o util.o

all: build test

build: $(OBJS)
\t$(CC) -o app $(OBJS)

main.o: main.c util.h
\t$(CC) -c main.c

test: build
\t./run-tests.sh

# CommentDecoy: fake target
DECOY := "StringDecoy in a string"
.PHONY: all test
`;

describe("{§mimetype-references} conformance: text/x-makefile defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-makefile",
            source: SOURCE,
            decoyNames: ["CommentDecoy", "StringDecoy"],
            expectJoins: [
                // The dependency graph make actually executes:
                // all →use→ build / test; test →use→ build.
                { refName: "build", container: "all" },
                { refName: "test", container: "all" },
                { refName: "build", container: "test" },
                // $(CC) in build's recipe joins to the CC variable def.
                { refName: "CC", container: "build" },
            ],
            expectRefs: [
                { name: "build", kind: "use", line: 4, container: "all" },
                { name: "test", kind: "use", line: 4, container: "all" },
                { name: "OBJS", kind: "use", line: 6, container: "build" },
                { name: "CC", kind: "use", line: 7, container: "build" },
                { name: "OBJS", kind: "use", line: 7, container: "build" },
                { name: "main.c", kind: "use", line: 9, container: "main.o" },
                { name: "util.h", kind: "use", line: 9, container: "main.o" },
                { name: "build", kind: "use", line: 12, container: "test" },
                // .PHONY's prerequisites reference real targets.
                { name: "all", kind: "use", line: 17, container: ".PHONY" },
            ],
        });
        // make emits use-kind only.
        assert.ok(references.every((r) => r.kind === "use"));
        // File prerequisites that aren't targets are present (honest rows)
        // but never required to join — main.c has no def.
        assert.ok(references.some((r) => r.name === "main.c"));
        // main.o IS both a prerequisite (via $(OBJS) expansion — not literal)
        // and a target; the literal prereq words main.c/util.h carry the
        // main.o rule as container via line containment.
        assert.equal(references.find((r) => r.name === "util.h")?.container, "main.o");
    });
});
}

// ─── ocaml.test.ts ───
{
// NOTE: the ocaml.ts mapping emits `module M = struct` defs as containers,
// so refs inside the module carry dotted paths (Shapes.area). Top-level let
// bindings carry the bare def name.
const SOURCE = `open Lexer
include Printable

module Shapes = struct
  type point = { x : int; y : int }

  type shape =
    | Circle of point * float
    | Rect of point * point

  let origin = { x = 0; y = 0 }

  let area (s : shape) : float =
    match s with
    | Circle (_, r) -> r *. r
    | Rect (_, _) -> 0.0
end

let make_circle (p : Shapes.point) (r : float) : Shapes.shape =
  Shapes.Circle (p, r)

let total (shapes : Shapes.shape list) : float =
  List.fold_left (fun acc s -> acc +. Shapes.area s) 0.0 shapes

let label = "StringDecoy should never surface"
(* CommentDecoy should never surface *)
`;

describe("{§mimetype-references} conformance: text/x-ocaml defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-ocaml",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // `Shapes.area s` inside total joins to the local def area —
                // exactly the service's (container, name) edge.
                { refName: "area", container: "total" },
                // Param annotation `(p : Shapes.point)` joins to the record
                // type def point inside module Shapes.
                { refName: "point", container: "make_circle" },
                // Variant payload type `Circle of point * float` joins from
                // inside the shape def to its sibling point def.
                { refName: "point", container: "Shapes.shape" },
            ],
            expectRefs: [
                // Final module_name of the open path.
                { name: "Lexer", kind: "import", line: 1 },
                // `include` is OCaml's closest inheritance analog.
                { name: "Printable", kind: "inherit", line: 2 },
                { name: "int", kind: "type", line: 5, container: "Shapes.point" },
                { name: "point", kind: "type", line: 8, container: "Shapes.shape" },
                { name: "shape", kind: "type", line: 13, container: "Shapes.area" },
                { name: "point", kind: "type", line: 19, container: "make_circle" },
                // Constructor application head (Shapes.Circle (p, r)).
                { name: "Circle", kind: "instantiate", line: 20, container: "make_circle" },
                { name: "shape", kind: "type", line: 22, container: "total" },
                // Member application head (List.fold_left ...).
                { name: "fold_left", kind: "call", line: 23, container: "total" },
                { name: "area", kind: "call", line: 23, container: "total" },
            ],
        });
        // Match-pattern constructor uses (| Circle (_, r) ->) are
        // deconstruction, not instantiation — never emitted.
        assert.ok(
            !references.some((r) => r.name === "Circle" && r.line !== 20),
            "constructor uses in match patterns must not surface",
        );
        // Application arguments and record-literal field names are bare
        // reads — never emitted (use is reserved).
        assert.ok(!references.some((r) => r.name === "shapes" || r.name === "acc" || r.name === "x"));
        // Type DEFINITION names never surface as type refs at their own
        // binding site (line 5 col 8 / line 7 col 8 are the defs).
        assert.ok(!references.some((r) => r.kind === "type" && (r.name === "point" || r.name === "shape") && r.column === 8));
    });
});
}

// ─── odin.test.ts ───
{
// NOTE: the odin.ts mapping is flat at the top level (procs are never
// nested), but struct fields and enum constants carry the owning type as
// container — so a type ref inside a field line resolves to the FIELD's
// qualified path ("Lexer.cur"), the innermost emitted def by line
// containment.
const SOURCE = `package main

import "core:fmt"

Token :: struct {
    kind: int,
    next: ^Token,
}

Color :: enum { Red, Green }

Lexer :: struct {
    cur: Token,
    colors: []Color,
}

make_token :: proc(kind: int) -> Token {
    t := Token{ kind = kind }
    return t
}

scan :: proc(lx: ^Lexer, t: Token) -> (Token, bool) {
    fmt.println("StringDecoy")
    next := make_token(1)
    helper(next)
    return next, true
}

helper :: proc(t: Token) {}

g_tok: Token

// CommentDecoy
`;

describe("{§mimetype-references} conformance: text/x-odin defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-odin",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // make_token(1) inside scan joins to the local proc def —
                // exactly the service's (container, name) edge.
                { refName: "make_token", container: "scan" },
                { refName: "helper", container: "scan" },
                // Field type use: container is the field's qualified path.
                { refName: "Token", container: "Lexer.cur" },
            ],
            expectRefs: [
                // Self-referential field type through a pointer wrapper.
                { name: "Token", kind: "type", line: 7, container: "Token.next" },
                { name: "Token", kind: "type", line: 13, container: "Lexer.cur" },
                // Element type of an array wrapper.
                { name: "Color", kind: "type", line: 14, container: "Lexer.colors" },
                // Return type of make_token.
                { name: "Token", kind: "type", line: 17, container: "make_token" },
                // Compound literal — Odin's instantiation idiom.
                { name: "Token", kind: "instantiate", line: 18, container: "make_token" },
                // Pointer param, plain param, and tuple result types of scan.
                { name: "Lexer", kind: "type", line: 22, container: "scan" },
                { name: "Token", kind: "type", line: 22, column: 29, container: "scan" },
                { name: "Token", kind: "type", line: 22, column: 40, container: "scan" },
                // Selector-final call (fmt.println) and bare calls.
                { name: "println", kind: "call", line: 23, container: "scan" },
                { name: "make_token", kind: "call", line: 24, container: "scan" },
                { name: "helper", kind: "call", line: 25, container: "scan" },
                { name: "Token", kind: "type", line: 29, container: "helper" },
                // Top-level var declaration's type; the var def is the
                // innermost (one-line) containing def.
                { name: "Token", kind: "type", line: 31, container: "g_tok" },
            ],
        });
        // Odin imports take collection-path strings, not symbol names — no
        // import refs ({§mimetype-references} bans path strings from the refs channel).
        assert.ok(!references.some((r) => r.kind === "import"), "no import refs for Odin");
        assert.ok(!references.some((r) => r.name === "core:fmt" || r.name === "fmt"));
        // No inheritance in Odin.
        assert.ok(!references.some((r) => r.kind === "inherit"), "no inherit refs for Odin");
        // Compound-literal FIELD names are data, not refs.
        assert.ok(!references.some((r) => r.name === "kind" && r.kind === "instantiate"));
    });
});
}

// ─── php.test.ts ───
{
const SOURCE = `<?php
namespace App {
    use Other\\Thing;
    use Lib\\Wide as W;

    class Parser extends Base implements Runnable {
        private Helper $helper;
        private ?Token $token;
        public function parse(string $input): Token {
            $h = new Helper();
            $h->run($input);
            Registry::lookup($input);
            return tokenize($input);
        }
    }
    interface Runnable {}
    trait Mixin {}
    enum Suit: string { case Hearts = 'h'; }
    class Helper {
        public function run(string $x): void { decoyFree($x); }
    }
    function tokenize(string $s): Token { return inner($s); }
}
$decoy = "StringDecoy() should never surface";
// CommentDecoy() should never surface
`;

describe("{§mimetype-references} conformance: text/x-php defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-php",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // new Helper() inside App\\Parser::parse joins to the local
                // class Helper — exactly the service's (container, name) edge.
                { refName: "Helper", container: "App.Parser.parse" },
                { refName: "tokenize", container: "App.Parser.parse" },
                { refName: "Runnable", container: "App.Parser" },
            ],
            expectRefs: [
                { name: "Thing", kind: "import", line: 3 },
                { name: "Wide", kind: "import", line: 4 },
                { name: "Base", kind: "inherit", line: 6 },
                { name: "Runnable", kind: "inherit", line: 6 },
                { name: "Helper", kind: "type", line: 7, container: "App.Parser.helper" },
                { name: "Token", kind: "type", line: 8, container: "App.Parser.token" },
                { name: "Token", kind: "type", line: 9, container: "App.Parser.parse" },
                { name: "Helper", kind: "instantiate", line: 10, container: "App.Parser.parse" },
                { name: "run", kind: "call", line: 11, container: "App.Parser.parse" },
                { name: "lookup", kind: "call", line: 12, container: "App.Parser.parse" },
                { name: "tokenize", kind: "call", line: 13, container: "App.Parser.parse" },
                { name: "inner", kind: "call", line: 22, container: "App.tokenize" },
            ],
        });
        // Aliased use captures the original name, never the alias.
        assert.ok(!references.some((r) => r.name === "W"));
        // primitive_type (string) is excluded from type refs; nullable
        // ?Token surfaces exactly once.
        assert.ok(!references.some((r) => r.name === "string"));
        assert.equal(references.filter((r) => r.name === "Token" && r.line === 8).length, 1);
    });
});
}

// ─── python.test.ts ───
{
const SOURCE = `from collections import OrderedDict
from helpers import shape as sh
import os.path

class Parser(Base, mixins.Runnable):
    field: Shape = None

    def parse(self, text: str) -> Token:
        h = Helper()
        h.run(text)
        return tokenize(text)

class Helper:
    def run(self, x: str) -> None:
        cleanup(os.path.join(x))

def tokenize(s: str) -> Token:
    return inner(s)

DECOY = "StringDecoy() should never surface"
# CommentDecoy() should never surface
`;

describe("{§mimetype-references} conformance: text/x-python defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-python",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // Helper() inside Parser.parse joins to the local class
                // Helper — exactly the service's (container, name) edge.
                // (Instantiation is syntactically a call in Python.)
                { refName: "Helper", container: "Parser.parse" },
                { refName: "tokenize", container: "Parser.parse" },
            ],
            expectRefs: [
                { name: "OrderedDict", kind: "import", line: 1 },
                { name: "shape", kind: "import", line: 2 },
                { name: "path", kind: "import", line: 3 },
                { name: "Base", kind: "inherit", line: 5 },
                { name: "Runnable", kind: "inherit", line: 5 },
                { name: "Shape", kind: "type", line: 6, container: "Parser.field" },
                { name: "str", kind: "type", line: 8, container: "Parser.parse" },
                { name: "Token", kind: "type", line: 8, container: "Parser.parse" },
                { name: "Helper", kind: "call", line: 9, container: "Parser.parse" },
                { name: "run", kind: "call", line: 10, container: "Parser.parse" },
                { name: "tokenize", kind: "call", line: 11, container: "Parser.parse" },
                // Nested attribute chain: only the outermost callee name.
                { name: "cleanup", kind: "call", line: 15, container: "Helper.run" },
                { name: "join", kind: "call", line: 15, container: "Helper.run" },
                { name: "inner", kind: "call", line: 18, container: "tokenize" },
            ],
        });
        // Aliased imports capture the original names, never the aliases.
        assert.ok(!references.some((r) => r.name === "sh"), "alias 'sh' must not surface");
        // Container precision: refs at class-body level vs method level.
        const fieldType = references.find((r) => r.name === "Shape" && r.line === 6);
        assert.equal(fieldType?.container, "Parser.field");
    });
});
}

// ─── ruby.test.ts ───
{
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

describe("{§mimetype-references} conformance: text/x-ruby defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
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
}

// ─── rust.test.ts ───
{
const SOURCE = `use std::collections::HashMap;
use crate::helper::{Widget, Shape as S};
use std::mem;

struct Helper {
    count: u32,
}

impl Helper {
    fn create() -> Helper {
        Helper { count: 0 }
    }
    fn process(&self, input: &str) -> Token {
        tokenize(input)
    }
}

trait Runnable {
    fn run(&self);
}

struct Engine {
    field: Shape,
    map: HashMap<String, Token>,
}

impl Runnable for Engine {
    fn run(&self) {
        let h: Helper = Helper::create();
        h.process("x");
        mem::drop(h);
    }
}

fn tokenize(s: &str) -> Token {
    inner(s)
}

const DECOY: &str = "StringDecoy() should never surface";
// CommentDecoy() should never surface
`;

describe("{§mimetype-references} conformance: text/x-rust defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-rust",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // let h: Helper inside Engine.run joins to the local struct
                // Helper — the service's (container, name) edge. The rust
                // mapping emits impl-typed containers, so methods carry the
                // impl'd type's name.
                { refName: "Helper", container: "Engine.run" },
                { refName: "create", container: "Engine.run" },
                { refName: "tokenize", container: "Helper.process" },
            ],
            expectRefs: [
                { name: "HashMap", kind: "import", line: 1 },
                { name: "Widget", kind: "import", line: 2 },
                // Aliased `Shape as S` captures the ORIGINAL name.
                { name: "Shape", kind: "import", line: 2 },
                { name: "mem", kind: "import", line: 3 },
                { name: "Helper", kind: "type", line: 10, container: "Helper.create" },
                { name: "Helper", kind: "instantiate", line: 11, container: "Helper.create" },
                { name: "Token", kind: "type", line: 13, container: "Helper.process" },
                { name: "tokenize", kind: "call", line: 14, container: "Helper.process" },
                { name: "Shape", kind: "type", line: 23, container: "Engine" },
                { name: "HashMap", kind: "type", line: 24, container: "Engine" },
                { name: "Runnable", kind: "inherit", line: 27 },
                { name: "Helper", kind: "type", line: 29, container: "Engine.run" },
                { name: "create", kind: "call", line: 29, container: "Engine.run" },
                { name: "process", kind: "call", line: 30, container: "Engine.run" },
                { name: "drop", kind: "call", line: 31, container: "Engine.run" },
                { name: "Token", kind: "type", line: 35, container: "tokenize" },
                { name: "inner", kind: "call", line: 36, container: "tokenize" },
            ],
        });
        // The alias itself (`S`) never surfaces — only the original name.
        assert.ok(!references.some((r) => r.name === "S"));
        // No bare identifier reads: `input`, `h`, `s` argument reads stay out.
        for (const bare of ["input", "h", "s"]) {
            assert.ok(
                !references.some((r) => r.name === bare),
                `bare identifier read "${bare}" surfaced as a ref`,
            );
        }
    });
});
}

// ─── scala.test.ts ───
{
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

describe("{§mimetype-references} conformance: text/x-scala defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
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
}

// ─── tsx.test.ts ───
{
// tsx = typescript refs + JSX component instantiation. Capitalized JSX names are
// component refs; lowercase host elements (<div>, <svg>) are filtered out.
const SOURCE = `import { Button } from "./ui/Button";
import { useState } from "react";

// the dashboard widget
interface Props {
  label: string;
}

function App(props: Props) {
  const [count, setCount] = useState(0);
  return (
    <Button onClick={() => setCount(count + 1)}>
      <Icon />
      <div>{count}</div>
    </Button>
  );
}

function Icon() {
  return <svg />;
}
`;

describe("{§mimetype-references} conformance: text/x-tsx refs", () => {
    it("{§mimetype-references} typescript refs + JSX component edges; host elements filtered", async () => {
        await runConformance({
            mimetype: "text/x-tsx",
            source: SOURCE,
            decoyNames: ["dashboard", "label"],
            expectJoins: [
                { refName: "Icon", container: "App" },
                { refName: "Props", container: "App" },
            ],
            expectRefs: [
                { name: "Button", kind: "instantiate" },
                { name: "Icon", kind: "instantiate" },
                { name: "useState", kind: "call" },
            ],
        });
    });

    it("{§mimetype-references} lowercase host elements (div, svg) are not refs (capitalization filter)", async () => {
        const entry = lookupTreeSitterLanguage("text/x-tsx")!;
        const h = new TreeSitterLanguageHandler(
            { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions },
            entry,
        );
        const refs = await h.references(SOURCE);
        assert.ok(!refs.some((r) => r.name === "div" || r.name === "svg"), "host elements must be filtered");
        assert.ok(refs.some((r) => r.name === "Icon" && r.kind === "instantiate"));
    });
});
}

// ─── zig.test.ts ───
{
// NOTE: the zig.ts mapping is FLAT for functions (methods inside struct
// declarations are not emitted), but struct container_fields carry the
// struct name as container — so refs on a field's own line resolve to the
// field's qualified path (e.g. "Token.shape"), refs elsewhere inside the
// struct body resolve to the struct, and refs in functions resolve to the
// bare function names.
const SOURCE = `const std = @import("std");

const Token = struct {
    kind: u8,
    shape: Shape,

    pub fn weight(self: Token) u32 {
        return self.shape.w;
    }
};

const Shape = struct { w: u32 };

pub fn tokenize(input: []const u8, sh: Shape) Token {
    std.debug.print("StringDecoy() {s}\\n", .{input});
    const n: u32 = @intCast(input.len);
    _ = n;
    return Token{ .kind = 1, .shape = sh };
}

pub fn helper(t: *Token, u: ?Token) !Shape {
    const s: Shape = Shape{ .w = 2 };
    _ = t.weight();
    _ = u;
    return s;
}

pub fn main() void {
    const sh = Shape{ .w = 1 };
    const tok = tokenize("x", sh);
    _ = helper(&tok, null);
}
// CommentDecoy() never surfaces
`;

describe("{§mimetype-references} conformance: text/x-zig defs + refs", () => {
    it("{§mimetype-references} passes the shared invariants and expected captures", async () => {
        const { references } = await runConformance({
            mimetype: "text/x-zig",
            source: SOURCE,
            decoyNames: ["StringDecoy", "CommentDecoy"],
            expectJoins: [
                // tokenize("x", sh) inside main joins to the local function
                // def — exactly the service's (container, name) edge.
                { refName: "tokenize", container: "main" },
                { refName: "helper", container: "main" },
                // Field type ref on the field's own line: the container_field
                // def is the innermost span, so the qualified path is the key.
                { refName: "Shape", container: "Token.shape" },
                { refName: "Shape", container: "helper" },
            ],
            expectRefs: [
                { name: "Shape", kind: "type", line: 5, container: "Token.shape" },
                // weight's param — the method is not a def, so the struct is
                // the innermost enclosing emitted def.
                { name: "Token", kind: "type", line: 7, container: "Token" },
                // Param and return types of tokenize.
                { name: "Shape", kind: "type", line: 14, container: "tokenize" },
                { name: "Token", kind: "type", line: 14, container: "tokenize" },
                // Member-call final (std.debug.print → print).
                { name: "print", kind: "call", line: 15, container: "tokenize" },
                { name: "Token", kind: "instantiate", line: 18, container: "tokenize" },
                // Pointer (*Token), nullable (?Token), error-union (!Shape).
                { name: "Token", kind: "type", line: 21, column: 19 },
                { name: "Token", kind: "type", line: 21, column: 30 },
                { name: "Shape", kind: "type", line: 21, column: 38 },
                // Explicitly typed const AND struct init on one line.
                { name: "Shape", kind: "type", line: 22, container: "helper" },
                { name: "Shape", kind: "instantiate", line: 22, container: "helper" },
                { name: "weight", kind: "call", line: 23, container: "helper" },
                { name: "Shape", kind: "instantiate", line: 29, container: "main" },
                { name: "tokenize", kind: "call", line: 30, container: "main" },
                { name: "helper", kind: "call", line: 31, container: "main" },
            ],
        });
        // @import takes path strings, not symbol names — no import refs for
        // Zig ({§mimetype-references} bans path strings from the refs channel).
        assert.ok(!references.some((r) => r.kind === "import"), "no import refs for Zig");
        assert.ok(!references.some((r) => r.name === "std"), "import path binding never surfaces");
        // Builtins are builtin_function nodes, not call_expressions —
        // compiler intrinsics never enter the refs stream.
        assert.ok(!references.some((r) => r.name.startsWith("@") || r.name === "intCast"));
    });
});
}
