import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";
import type { MimeSymbol, SymbolKind } from "../types.ts";

// One emitted symbol's asserted facts ({§mimetype-symbol}). A key left out asserts nothing;
// `container: undefined`, written out, asserts absence ({§mimetype-symbol-container}).
interface Expectation {
    readonly kind?: SymbolKind;
    readonly params?: readonly string[];
    readonly container?: string;
    readonly line?: number;
    readonly endLine?: number;
    // `column` also asserts an `endColumn` of at least 1: the pair is present together ({§text-region}).
    readonly column?: number;
    readonly endColumn?: number;
}

// One source and what its extraction must and must not emit.
interface Snippet {
    readonly source: string;
    readonly expect?: Readonly<Record<string, Expectation>>;
    readonly absent?: readonly string[];
    // Symbols are emitted and none carries a container.
    readonly flat?: true;
    // An assertion the columns above cannot spell.
    readonly also?: (symbols: MimeSymbol[]) => void;
}

// A handler-level witness that is not one extraction of one source.
interface Witness {
    readonly title: string;
    readonly run: (make: () => TreeSitterLanguageHandler) => Promise<void>;
}

interface Language {
    readonly mimetype: string;
    readonly sources: readonly Snippet[];
    readonly malformed: readonly string[];
    // The top-level case: no container, 1-indexed columns ({§mimetype-symbol-container}).
    readonly topLevel: Snippet;
    readonly also?: readonly Witness[];
}

const LANGUAGES: readonly Language[] = [
    {
        mimetype: "text/x-shellscript",
        sources: [
            {
                source: "function greet() {\n  echo hi\n}\n\nfarewell() {\n  echo bye\n}\n",
                expect: { greet: { kind: "function" }, farewell: { kind: "function" } },
            },
            { source: "DB_HOST=localhost\n", expect: { DB_HOST: { kind: "variable" } } },
            { source: "readonly DB_PORT=5432\n", expect: { DB_PORT: { kind: "constant" } } },
            // declare/export wraps still extract the variable.
            { source: "declare -x APP_ENV=prod\nexport AWS_REGION=us-east-1\n", expect: { APP_ENV: {}, AWS_REGION: {} } },
        ],
        malformed: ["function (((broken"],
        topLevel: {
            source: "greet() {\n  echo hi\n}\nDB_HOST=localhost\n",
            expect: { greet: { container: undefined, column: 1 }, DB_HOST: { container: undefined, column: 1 } },
        },
    },
    {
        mimetype: "text/x-c",
        sources: [
            { source: "int add(int a, int b) { return a + b; }\n", expect: { add: { kind: "function", params: ["a", "b"] } } },
            { source: "struct Point { int x; int y; };\nunion U { int i; float f; };\n", expect: { Point: { kind: "class" }, U: { kind: "class" } } },
            {
                source: "enum Color { RED, GREEN, BLUE };\n",
                expect: { Color: { kind: "enum" }, RED: { kind: "constant" }, GREEN: { kind: "constant" } },
            },
            { source: "typedef int my_int_t;\n", expect: { my_int_t: { kind: "type" } } },
            // A function prototype is not a definition.
            { source: "int counter = 0;\nint missing_proto(int x);\n", expect: { counter: { kind: "variable" } }, absent: ["missing_proto"] },
            {
                source: "enum Color { RED, GREEN };\n",
                expect: { Color: { container: undefined }, RED: { container: "Color" }, GREEN: { container: "Color" } },
            },
        ],
        malformed: ["int ((( broken"],
        topLevel: { source: "int solo(void) { return 0; }\n", expect: { solo: { container: undefined, column: 1 } } },
    },
    {
        mimetype: "text/x-cpp",
        sources: [
            {
                source: "class Foo {\npublic:\n  void bar(int x) { }\n};\n",
                expect: { Foo: { kind: "class" }, bar: { kind: "method", params: ["x"] } },
            },
            { source: "struct P { int x; int y; };\n", expect: { P: { kind: "class" }, x: { kind: "field" }, y: { kind: "field" } } },
            {
                source: "namespace ns {\nclass Inner { };\nint global = 1;\n}\n",
                expect: { ns: { kind: "module" }, Inner: { kind: "class" }, global: { kind: "variable" } },
            },
            { source: "enum Color { RED, GREEN };\n", expect: { Color: { kind: "enum" }, RED: { kind: "constant", container: "Color" } } },
            // template_declaration unwraps to the inner declaration.
            { source: "template<typename T>\nclass Box { T value; };\n", expect: { Box: { kind: "class" } } },
            { source: "using MyInt = int;\n", expect: { MyInt: { kind: "type" } } },
            {
                source: "namespace ns {\nclass Box {\npublic:\n  int width;\n  void resize(int w) {}\n};\n}\n",
                expect: { ns: { container: undefined }, Box: { container: "ns" }, width: { container: "ns.Box" }, resize: { container: "ns.Box" } },
            },
            // A function inside a namespace keeps function kind and carries the namespace.
            { source: "namespace ns {\nvoid helper() {}\n}\n", expect: { helper: { kind: "function", container: "ns" } } },
        ],
        malformed: ["class ((( broken"],
        topLevel: { source: "void solo() {}\n", expect: { solo: { container: undefined, column: 1 } } },
    },
    {
        mimetype: "text/css",
        sources: [
            {
                source: ".card { color: red; }\n#main, nav > ul { margin: 0; }\n",
                expect: { ".card": { kind: "field" }, "#main, nav > ul": { kind: "field" } },
            },
            // :root custom properties are constants; an ordinary declaration is not a symbol.
            {
                source: ":root {\n  --brand: #f00;\n  --gap: 1rem;\n  color: black;\n}\n",
                expect: { ":root": { kind: "field" }, "--brand": { kind: "constant" }, "--gap": { kind: "constant" } },
                absent: ["color"],
            },
            { source: "@keyframes spin { from { rotate: 0deg; } to { rotate: 360deg; } }\n", expect: { spin: { kind: "module" } } },
            {
                source: "@media (max-width: 600px) {\n  .compact { display: none; }\n}\n",
                expect: { "@media (max-width: 600px)": { kind: "module" }, ".compact": { kind: "field" } },
            },
            // Line positions are 1-based.
            { source: "/* header */\n.first { color: red; }\n", expect: { ".first": { line: 2 } } },
            {
                source: "@media (max-width: 600px) {\n  .card { color: red; }\n}\n",
                expect: { "@media (max-width: 600px)": { container: undefined }, ".card": { container: "@media (max-width: 600px)" } },
            },
            { source: ":root {\n  --brand: #f00;\n}\n", expect: { ":root": { container: undefined }, "--brand": { container: ":root" } } },
        ],
        malformed: ["{{{ not css"],
        topLevel: { source: ".top { margin: 0; }\n", expect: { ".top": { container: undefined, column: 1 } } },
    },
    {
        mimetype: "text/x-dart",
        sources: [
            {
                source: "class Foo {\n  String name = '';\n  void greet(String prefix) {}\n}\n",
                expect: { Foo: { kind: "class" }, greet: { kind: "method", params: ["prefix"] }, name: { kind: "field" } },
            },
            { source: "int add(int a, int b) => a + b;\n", expect: { add: { kind: "function", params: ["a", "b"] } } },
            { source: "mixin Greeter { void hi() {} }\n", expect: { Greeter: { kind: "class" } } },
            {
                source: "class Foo {\n  String name = '';\n  void greet(String prefix) {}\n}\nmixin Greeter { void hi() {} }\n",
                expect: { Foo: { container: undefined }, name: { container: "Foo" }, greet: { container: "Foo" }, hi: { container: "Greeter" } },
            },
            // Def spans cover sibling bodies ({§mimetype-references}).
            {
                source: "class Foo {\n  int twice(int n) {\n    final m = n * 2;\n    return m;\n  }\n}\n",
                expect: { twice: { line: 2, endLine: 5 } },
            },
            { source: "int add(int a, int b) {\n  return a + b;\n}\n", expect: { add: { line: 1, endLine: 3 } } },
            {
                source: "class Foo {\n  Foo(this.x) {\n    init();\n  }\n  int get size {\n    return 42;\n  }\n}\n",
                expect: { Foo: { kind: "method", endLine: 4 }, size: { endLine: 7 } },
            },
            // Enum constants surface from the enum body.
            {
                source: "enum Color {\n  red,\n  green,\n  blue,\n}\n",
                expect: { Color: { kind: "enum" }, red: { kind: "constant", container: "Color" }, blue: { container: "Color" } },
            },
        ],
        malformed: ["class ((( broken"],
        topLevel: { source: "int add(int a, int b) => a + b;\n", expect: { add: { container: undefined, column: 1 } } },
    },
    {
        mimetype: "text/x-elixir",
        sources: [
            {
                source: "defmodule MyApp.User do\n  def greet(name) do\n    name\n  end\nend\n",
                expect: { "MyApp.User": { kind: "module" }, greet: { kind: "function", params: ["name"] } },
            },
            // defp and defmacro are structurally functions.
            { source: "defmodule M do\n  defp helper(x), do: x\nend\n", expect: { helper: { kind: "function" } } },
            {
                source: "defmodule M do\n  defmacro unless(cond, do: body) do\n    quote do: if !unquote(cond), do: unquote(body)\n  end\nend\n",
                expect: { unless: { kind: "function" } },
            },
            { source: "defmodule M do\n  def version, do: \"1.0\"\nend\n", expect: { version: { kind: "function", params: [] } } },
            { source: "defmodule M do\n  def positive?(n) when n > 0, do: true\nend\n", expect: { "positive?": { kind: "function" } } },
            // A dotted alias is one verbatim container segment.
            {
                source: "defmodule MyApp.User do\n  defmodule Inner do\n    def deep(x), do: x\n  end\n  def greet(name), do: name\nend\n",
                expect: {
                    "MyApp.User": { container: undefined },
                    Inner: { container: "MyApp.User" },
                    deep: { container: "MyApp.User.Inner" },
                    greet: { container: "MyApp.User" },
                },
            },
        ],
        malformed: ["defmodule ((( broken"],
        topLevel: { source: "defmodule M do\nend\n", expect: { M: { container: undefined, column: 1 } } },
    },
    {
        mimetype: "text/x-fsharp",
        sources: [
            {
                source: "module M\nlet add a b = a + b\ntype Person = { Name: string; Age: int }\ntype Color = Red | Green | Blue\n",
                expect: {
                    M: { kind: "module" },
                    add: { kind: "function", params: ["a", "b"] },
                    Person: { kind: "class" },
                    Name: { kind: "field" },
                    Color: { kind: "enum" },
                    Red: { kind: "constant" },
                },
            },
            { source: "module M\nlet pi = 3.14\n", expect: { pi: { kind: "constant" } } },
            // Record fields and union cases append the type to the module container.
            {
                source: "module M\nlet add a b = a + b\ntype Person = { Name: string; Age: int }\ntype Color = Red | Green\n",
                expect: {
                    M: { container: undefined },
                    add: { container: "M" },
                    Person: { container: "M" },
                    Name: { container: "M.Person" },
                    Color: { container: "M" },
                    Red: { container: "M.Color" },
                },
            },
            // An implicit-constructor type emits the type and its members ({§mimetype-references}).
            {
                source: "module M\ntype Parser(token: string) =\n    member this.Run x = x\n    member val Count = 0 with get, set\n    let mutable cache = 0\n",
                expect: {
                    Parser: { kind: "class", container: "M" },
                    Run: { kind: "method", container: "M.Parser", params: ["x"] },
                    Count: { kind: "field", container: "M.Parser" },
                    cache: { kind: "constant", container: "M.Parser" },
                },
            },
            // Abstract member signatures and interface implementations carry their type.
            {
                source: "module M\ntype Runnable =\n    abstract member Run: int -> int\ntype Parser() =\n    interface Runnable with\n        member this.Run x = x\n",
                expect: { Runnable: { kind: "class" } },
                also: (symbols) => {
                    const runs = symbols.filter((s) => s.name === "Run");
                    assert.deepEqual(runs.map((s) => s.container), ["M.Runnable", "M.Parser"]);
                    assert.ok(runs.every((s) => s.kind === "method"));
                },
            },
        ],
        malformed: ["module ((( broken"],
        topLevel: { source: "module M\nlet pi = 3.14\n", expect: { M: { container: undefined, column: 1 } } },
    },
    {
        mimetype: "text/x-go",
        sources: [
            { source: "package foo\n", expect: { foo: { kind: "module" } } },
            { source: "package x\nfunc Add(a int, b int) int { return a + b }\n", expect: { Add: { kind: "function", params: ["a", "b"] } } },
            { source: "package x\ntype T struct{}\nfunc (t *T) Do(x int) {}\n", expect: { Do: { kind: "method", params: ["x"] } } },
            {
                source: "package x\ntype Point struct { X, Y int }\ntype Reader interface { Read() int }\ntype Name = string\n",
                expect: { Point: { kind: "class" }, Reader: { kind: "interface" }, Name: { kind: "type" } },
            },
            { source: "package x\nconst Max = 100\nvar Count int\n", expect: { Max: { kind: "constant" }, Count: { kind: "variable" } } },
            // Flat mapping: no symbol carries a container.
            { source: "package x\ntype T struct{}\nfunc (t *T) Do() {}\nfunc free() {}\n", flat: true },
        ],
        malformed: ["package ((( broken"],
        topLevel: { source: "package x\nfunc solo() {}\n", expect: { solo: { container: undefined, column: 1 } } },
    },
    {
        mimetype: "text/x-haskell",
        sources: [
            { source: "module Foo where\n", expect: { Foo: { kind: "module" } } },
            { source: "data Maybe a = Nothing | Just a\nnewtype Age = Age Int\n", expect: { Maybe: { kind: "class" }, Age: { kind: "class" } } },
            { source: "type Name = String\n", expect: { Name: { kind: "type" } } },
            { source: "class Eq a where\n  eq :: a -> a -> Bool\n", expect: { Eq: { kind: "interface" }, eq: { kind: "method" } } },
            // A signature and its equations deduplicate to one function whose span covers the body ({§mimetype-references}).
            {
                source: "bar :: Int -> Int\nbar x = x + 1\n",
                expect: { bar: { kind: "function", line: 1, endLine: 2 } },
                also: (symbols) => assert.equal(symbols.filter((s) => s.name === "bar").length, 1),
            },
            {
                source: "fib :: Int -> Int\nfib 0 = 0\nfib 1 = 1\nfib n = fib (n - 1) + fib (n - 2)\n",
                expect: { fib: { line: 1, endLine: 4 } },
                also: (symbols) => assert.equal(symbols.filter((s) => s.name === "fib").length, 1),
            },
            { source: "step 0 = 1\nstep n = n - 1\n", expect: { step: { line: 1, endLine: 2 } } },
            // Class method signatures carry the type class; declarations are otherwise flat.
            {
                source: "module Foo where\nclass Eq a where\n  eq :: a -> a -> Bool\ndata Maybe a = Nothing | Just a\n",
                expect: { Eq: { container: undefined }, eq: { container: "Eq" }, Maybe: { container: undefined } },
            },
        ],
        malformed: ["module ((( broken"],
        topLevel: { source: "bar :: Int -> Int\nbar x = x + 1\n", expect: { bar: { container: undefined, column: 1 } } },
    },
    {
        mimetype: "text/x-java",
        sources: [
            {
                source: "public class Foo {\n  public void bar(int x, String y) {}\n}\n",
                expect: { Foo: { kind: "class" }, bar: { kind: "method", params: ["x", "y"] } },
            },
            { source: "public interface Doable {\n  void doIt();\n}\n", expect: { Doable: { kind: "interface" }, doIt: { kind: "method" } } },
            {
                source: "enum Color { RED, GREEN, BLUE }\n",
                expect: { Color: { kind: "enum" }, RED: { kind: "constant" }, GREEN: { kind: "constant" } },
            },
            { source: "record Point(int x, int y) {}\n", expect: { Point: { kind: "class" } } },
            { source: "class C {\n  private int count;\n  public String name;\n}\n", expect: { count: { kind: "field" }, name: { kind: "field" } } },
            // A constructor is a method named after its class.
            { source: "class C {\n  public C(int x) {}\n}\n", expect: { C: { kind: "method", params: ["x"] } } },
            {
                source: "class Outer {\n  class Inner {\n    void deep() {}\n  }\n  void shallow() {}\n  int count;\n}\n",
                expect: {
                    Outer: { container: undefined },
                    Inner: { container: "Outer" },
                    deep: { container: "Outer.Inner" },
                    shallow: { container: "Outer" },
                    count: { container: "Outer" },
                },
            },
        ],
        malformed: ["class ((( broken"],
        topLevel: {
            source: "enum Color { RED }\n",
            expect: { Color: { container: undefined, column: 1 }, RED: { container: "Color" } },
        },
    },
    {
        mimetype: "text/javascript",
        sources: [
            { source: "function add(a, b) { return a + b; }\n", expect: { add: { kind: "function", params: ["a", "b"] } } },
            {
                source: "class Counter {\n  count = 0;\n  increment(by) { this.count += by; }\n}\n",
                expect: {
                    Counter: { kind: "class", container: undefined },
                    increment: { kind: "method", params: ["by"], container: "Counter" },
                    count: { kind: "field", container: "Counter" },
                },
            },
            // A SCREAMING const is a constant; any other const or let is a variable.
            {
                source: "const MAX = 100;\nconst x = 1;\nlet y = 2;\n",
                expect: { MAX: { kind: "constant" }, x: { kind: "variable" }, y: { kind: "variable" } },
            },
            { source: "const sum = (a, b) => a + b;\n", expect: { sum: { kind: "function", params: ["a", "b"] } } },
            // Export declarations unwrap.
            { source: "export function foo() {}\nexport class Bar {}\n", expect: { foo: { kind: "function" }, Bar: { kind: "class" } } },
        ],
        malformed: ["function ((( broken"],
        topLevel: { source: "function solo(a) { return a; }\n", expect: { solo: { container: undefined, column: 1 } } },
    },
    {
        mimetype: "text/x-julia",
        sources: [
            {
                source: "module M\nstruct Point\n  x::Int\nend\nfunction add(a, b) a + b end\nabstract type Shape end\nend\n",
                expect: { M: { kind: "module" }, Point: { kind: "class" }, add: { kind: "method", params: ["a", "b"] }, Shape: { kind: "class" } },
            },
            { source: "sq(x) = x * x\n", expect: { sq: { kind: "function", params: ["x"] } } },
            { source: "mutable struct Counter\n  n::Int\nend\n", expect: { Counter: { kind: "class" } } },
            {
                source: "module Outer\nmodule Inner\nf(x) = x\nend\nstruct Point\n  x::Int\nend\nend\n",
                expect: { Outer: { container: undefined }, Inner: { container: "Outer" }, f: { container: "Outer.Inner" }, Point: { container: "Outer" } },
            },
        ],
        malformed: ["module ((( broken"],
        topLevel: { source: "sq(x) = x * x\n", expect: { sq: { container: undefined, column: 1 } } },
    },
    {
        mimetype: "text/x-kotlin",
        sources: [
            {
                source: "class Foo {\n  val name: String = \"\"\n  fun greet(prefix: String): String = prefix + name\n}\n",
                expect: { Foo: { kind: "class" }, greet: { kind: "method", params: ["prefix"] }, name: { kind: "field" } },
            },
            { source: "fun add(a: Int, b: Int): Int = a + b\n", expect: { add: { kind: "function", params: ["a", "b"] } } },
            { source: "object Singleton { fun x() = 1 }\n", expect: { Singleton: { kind: "class" } } },
            {
                source: "package com.example.app\nclass C {}\n",
                also: (symbols) => assert.ok(symbols.find((s) => s.kind === "module"), "package_header should produce a module symbol"),
            },
            {
                source: "class Outer {\n  class Inner {\n    fun deep() = 1\n  }\n  fun shallow() = 1\n  val name: String = \"\"\n}\n",
                expect: {
                    Outer: { container: undefined },
                    Inner: { container: "Outer" },
                    deep: { container: "Outer.Inner" },
                    shallow: { container: "Outer" },
                    name: { container: "Outer" },
                },
            },
        ],
        malformed: ["class ((( broken"],
        topLevel: { source: "fun add(a: Int, b: Int): Int = a + b\n", expect: { add: { container: undefined, column: 1 } } },
    },
    {
        mimetype: "text/x-lua",
        sources: [
            {
                source: "local M = {}\nfunction M.foo(x, y) return x + y end\nlocal function bar(z) return z end\nfunction Class:greet(a) return a end\nreturn M\n",
                expect: {
                    M: { kind: "variable" },
                    foo: { kind: "method", params: ["x", "y"] },
                    bar: { kind: "function", params: ["z"] },
                    greet: { kind: "method", params: ["a"] },
                },
            },
            { source: "local MAX_SIZE = 100\n", expect: { MAX_SIZE: { kind: "constant" } } },
        ],
        malformed: ["function ((( broken"],
        // Flat mapping: no recursion into named scopes, so no containers.
        topLevel: {
            source: "local function bar(z) return z end\nlocal v = 1\n",
            expect: { bar: { container: undefined, column: 1 }, v: { container: undefined, column: 1 } },
        },
    },
    {
        mimetype: "text/x-makefile",
        sources: [
            { source: "PREFIX = /usr/local\nlocal_var = x\n", expect: { PREFIX: { kind: "constant" }, local_var: { kind: "variable" } } },
            // Rule targets are one function per word.
            { source: "all: build\n\t@echo done\nbuild:\n\tgcc main.c\n", expect: { all: { kind: "function" }, build: { kind: "function" } } },
        ],
        malformed: [":::\n"],
        topLevel: {
            source: "PREFIX = /usr/local\nbuild:\n\tgcc main.c\n",
            expect: { build: { container: undefined, column: 1 }, PREFIX: { container: undefined, column: 1 } },
        },
    },
    {
        mimetype: "text/x-ocaml",
        sources: [
            { source: "module M = struct\nend\n", expect: { M: { kind: "module" } } },
            {
                source: "type t = { x: int; y: int }\ntype direction = North | South\ntype name = string\n",
                expect: { t: { kind: "class" }, direction: { kind: "class" }, name: { kind: "type" } },
            },
            { source: "let add x y = x + y\nlet pi = 3.14\n", expect: { add: { kind: "function", params: ["x", "y"] }, pi: { kind: "constant" } } },
            { source: "exception NotFound\n", expect: { NotFound: { kind: "class" } } },
            { source: "class point x y = object\n  val mutable x = x\nend\n", expect: { point: { kind: "class" } } },
            {
                source: "module Outer = struct\n  module Inner = struct\n    let deep x = x\n  end\n  let shallow = 1\nend\n",
                expect: { Outer: { container: undefined }, Inner: { container: "Outer" }, deep: { container: "Outer.Inner" }, shallow: { container: "Outer" } },
            },
        ],
        malformed: ["module ((( broken"],
        // `add` anchors on the let_binding, which starts after `let `.
        topLevel: {
            source: "module M = struct\nend\nlet add x y = x + y\n",
            expect: { add: { container: undefined, column: 5 }, M: { column: 1 } },
        },
    },
    {
        mimetype: "text/x-odin",
        sources: [
            {
                source: "package main\nadd :: proc(a, b: int) -> int { return a + b }\nPoint :: struct { x, y: int }\nColor :: enum { Red, Green }\nMAX :: 100\n",
                expect: {
                    main: { kind: "module" },
                    add: { kind: "function" },
                    Point: { kind: "class" },
                    Color: { kind: "enum" },
                    Red: { kind: "constant" },
                    MAX: { kind: "constant" },
                },
            },
            {
                source: "package main\nPoint :: struct { x: int, y: int }\nColor :: enum { Red, Green }\n",
                expect: {
                    Point: { container: undefined },
                    x: { container: "Point" },
                    y: { container: "Point" },
                    Color: { container: undefined },
                    Red: { container: "Color" },
                },
            },
        ],
        malformed: ["proc ((( broken"],
        topLevel: {
            source: "package main\nadd :: proc(a, b: int) -> int { return a + b }\n",
            expect: { add: { container: undefined, column: 1 } },
        },
    },
    {
        mimetype: "text/x-php",
        sources: [
            {
                source: "<?php\nclass User {\n  public string $name;\n  public function greet($prefix) { return $prefix . $this->name; }\n}\n",
                expect: { User: { kind: "class" }, greet: { kind: "method", params: ["prefix"] }, name: { kind: "field" } },
            },
            { source: "<?php\nfunction add($a, $b) { return $a + $b; }\n", expect: { add: { kind: "function", params: ["a", "b"] } } },
            {
                source: "<?php\ninterface Doable { public function run(); }\ntrait Greeter { public function hi() {} }\n",
                expect: { Doable: { kind: "interface" }, Greeter: { kind: "class" } },
            },
            { source: "<?php\nenum Color { case Red; case Green; }\n", expect: { Color: { kind: "enum" }, Red: { kind: "constant" } } },
            {
                source: "<?php\nnamespace App\\Domain;\nclass C {}\n",
                expect: { C: { kind: "class" } },
                also: (symbols) => assert.ok(symbols.find((s) => s.kind === "module"), "namespace should produce a module symbol"),
            },
            {
                source: "<?php\nclass User {\n  public string $name;\n  public function greet($prefix) { return $prefix; }\n}\n",
                expect: { User: { container: undefined }, greet: { container: "User" }, name: { container: "User" } },
            },
        ],
        malformed: ["<?php class ((( broken"],
        topLevel: { source: "<?php\nfunction add($a, $b) { return $a + $b; }\n", expect: { add: { container: undefined, column: 1 } } },
    },
    {
        mimetype: "text/x-python",
        sources: [
            { source: "def add(a, b):\n    return a + b\n", expect: { add: { kind: "function", params: ["a", "b"] } } },
            {
                source: [
                    "class Parser:",
                    "    name = \"\"",
                    "    def parse(self, source):",
                    "        return source",
                    "    def load(self, path, strict):",
                    "        return path",
                    "",
                ].join("\n"),
                expect: {
                    Parser: { kind: "class" },
                    name: { kind: "field" },
                    parse: { kind: "method", params: ["self", "source"] },
                    load: { params: ["self", "path", "strict"] },
                },
            },
            // A SCREAMING_SNAKE assignment is a constant.
            { source: "MAX_RETRIES = 3\nversion = 1\n", expect: { MAX_RETRIES: { kind: "constant" }, version: { kind: "variable" } } },
            // Decorators unwrap to the inner definition.
            {
                source: ["@dataclass", "class Point:", "    x: int", "    y: int", "", "@staticmethod", "def helper():", "    pass", ""].join("\n"),
                expect: { Point: { kind: "class" }, helper: { kind: "function" } },
            },
            { source: "async def fetch(url):\n    pass\n", expect: { fetch: { kind: "function", params: ["url"] } } },
            // Function-body locals are excluded: no recursion into function bodies.
            {
                source: ["def compute():", "    x = 1", "    y = 2", "    return x + y", ""].join("\n"),
                also: (symbols) => assert.deepEqual(symbols.map((s) => s.name), ["compute"]),
            },
            {
                source: "class Outer:\n    class Inner:\n        def deep(self):\n            pass\n    def shallow(self):\n        pass\n",
                expect: { Outer: { container: undefined }, Inner: { container: "Outer" }, deep: { container: "Outer.Inner" }, shallow: { container: "Outer" } },
            },
            // Astral and combining characters count as one code point each ({§mimetype-parser-coordinates}).
            {
                source: "def 𝐀(): return 1\n",
                also: (symbols) => assert.deepEqual(symbols.find((s) => s.name === "𝐀"), {
                    name: "𝐀", kind: "function", line: 1, column: 1, endLine: 1, endColumn: 18, params: [],
                }),
            },
            { source: "def cafe\u0301(): return 1\n", expect: { "cafe\u0301": { endColumn: 22 } } },
        ],
        malformed: ["def (((broken", "@@ totally bogus"],
        topLevel: { source: "def solo():\n    pass\n", expect: { solo: { container: undefined, column: 1 } } },
        also: [
            ...["                    ", "\n\n    ", "# café 🌍\r\n    "].map((prefix): Witness => ({
                title: `{§mimetype-parser-coordinates} text/x-python preserves the source origin of indented references (${JSON.stringify(prefix)})`,
                run: async (make) => {
                    const h = make();
                    try {
                        const source = `${prefix}kwargs[key] = converter.to_python(value)`;
                        const refs = await h.references(source);
                        const call = refs.find((ref) => ref.name === "to_python");
                        const lines = source.split(/\r\n|\n/);
                        const last = lines.at(-1) ?? "";
                        const column = Array.from(last.slice(0, last.indexOf("to_python"))).length + 1;
                        assert.deepEqual(call, {
                            name: "to_python", kind: "call", line: lines.length, column,
                            endLine: lines.length, endColumn: column + "to_python".length, container: "kwargs",
                        });
                    } finally { await h.dispose(); }
                },
            })),
            {
                title: "{§mimetype-parser-coordinates} text/x-python normalizes reference columns after astral source text",
                run: async (make) => {
                    const refs = await make().references("def f(): \"😀\"; g()\n");
                    assert.deepEqual(refs.find((ref) => ref.name === "g"), {
                        name: "g", kind: "call", line: 1, column: 15, endLine: 1, endColumn: 16, container: "f",
                    });
                },
            },
            {
                title: "text/x-python primes the parser cache — second call doesn't re-init WASM",
                run: async (make) => {
                    const h = make();
                    const t0 = process.hrtime.bigint();
                    await h.extractRaw("def first(): pass\n");
                    const t1 = process.hrtime.bigint();
                    await h.extractRaw("def second(): pass\n");
                    const t2 = process.hrtime.bigint();
                    const firstMs = Number(t1 - t0) / 1e6;
                    const secondMs = Number(t2 - t1) / 1e6;
                    assert.ok(secondMs < firstMs, `second call (${secondMs.toFixed(1)}ms) should be faster than first (${firstMs.toFixed(1)}ms) — cache primed`);
                },
            },
        ],
    },
    {
        mimetype: "text/x-ruby",
        sources: [
            {
                source: "module MyApp\n  class User\n    def initialize(name)\n      @name = name\n    end\n  end\nend\n",
                expect: {
                    MyApp: { kind: "module", container: undefined },
                    User: { kind: "class", container: "MyApp" },
                    initialize: { kind: "method", params: ["name"], container: "MyApp.User" },
                },
            },
            { source: "CONST = 42\n", expect: { CONST: { kind: "constant" } } },
            { source: "class C\n  attr_accessor :name, :age\nend\n", expect: { name: { kind: "field" }, age: { kind: "field" } } },
            // def self.foo is a singleton method.
            { source: "class C\n  def self.find(id)\n    nil\n  end\nend\n", expect: { find: { kind: "method", params: ["id"] } } },
        ],
        malformed: ["class ((( broken"],
        topLevel: { source: "def solo(x)\n  x\nend\n", expect: { solo: { container: undefined, column: 1 } } },
    },
    {
        mimetype: "text/x-rust",
        sources: [
            { source: "fn add(a: i32, b: i32) -> i32 { a + b }\n", expect: { add: { kind: "function", params: ["a", "b"] } } },
            // A fn inside a trait body is a method.
            {
                source: "struct P { x: i32 }\nenum E { A, B }\nunion U { a: i32, b: f32 }\ntrait T { fn run(&self); }\n",
                expect: { P: { kind: "class" }, E: { kind: "enum" }, U: { kind: "class" }, T: { kind: "interface" }, run: { kind: "method" } },
            },
            { source: "struct C;\nimpl C { fn foo(&self, x: i32) {} }\n", expect: { foo: { kind: "method", params: ["self", "x"] } } },
            // A mod block recurses into its children.
            { source: "mod inner { fn deep() {} struct S; }\n", expect: { inner: { kind: "module" }, deep: { kind: "function" }, S: { kind: "class" } } },
            {
                source: "const MAX: i32 = 100;\nstatic GLOBAL: i32 = 7;\ntype Name = String;\n",
                expect: { MAX: { kind: "constant" }, GLOBAL: { kind: "constant" }, Name: { kind: "type" } },
            },
            // impl methods carry the impl'd type; mod nesting is dotted.
            {
                source: "mod inner {\n  struct S;\n  impl S { fn act(&self) {} }\n  fn deep() {}\n}\n",
                expect: {
                    inner: { container: undefined },
                    S: { container: "inner" },
                    act: { container: "inner.S" },
                    deep: { kind: "function", container: "inner" },
                },
            },
            // A generic impl resolves to the base type name; trait fns carry the trait.
            {
                source: "struct Wrap<T>(T);\nimpl<T> Wrap<T> { fn get(&self) {} }\ntrait Tr { fn req(&self); }\n",
                expect: { get: { container: "Wrap" }, req: { container: "Tr" } },
            },
        ],
        malformed: ["fn ((( broken"],
        topLevel: { source: "fn solo() {}\n", expect: { solo: { container: undefined, column: 1 } } },
    },
    {
        mimetype: "text/x-scala",
        sources: [
            {
                source: "class Foo {\n  def bar(x: Int, y: Int): Int = x + y\n}\n",
                expect: { Foo: { kind: "class" }, bar: { kind: "method", params: ["x", "y"] } },
            },
            { source: "object Main { def main(args: Array[String]): Unit = () }\n", expect: { Main: { kind: "class" } } },
            { source: "trait Doable { def run(): Unit }\n", expect: { Doable: { kind: "interface" } } },
            // A top-level val is a constant; a class-body val is a field.
            { source: "val pi = 3.14\nclass C { val x = 1 }\n", expect: { pi: { kind: "constant" }, x: { kind: "field" } } },
            { source: "type Name = String\n", expect: { Name: { kind: "type" } } },
            {
                source: "object Outer {\n  object Inner {\n    def deep() = 1\n  }\n  def shallow() = 1\n  val k = 1\n}\n",
                expect: {
                    Outer: { container: undefined },
                    Inner: { container: "Outer" },
                    deep: { container: "Outer.Inner" },
                    shallow: { container: "Outer" },
                    k: { container: "Outer" },
                },
            },
            // A package block qualifies the container but keeps top-level kinds.
            {
                source: "package foo.bar {\n  class C {\n    def m() = 1\n  }\n  def free() = 1\n}\n",
                expect: { C: { container: "foo.bar" }, m: { container: "foo.bar.C" }, free: { kind: "function", container: "foo.bar" } },
            },
        ],
        malformed: ["class ((( broken"],
        topLevel: { source: "def solo(x: Int) = x\n", expect: { solo: { container: undefined, column: 1 } } },
    },
    {
        mimetype: "application/toml",
        sources: [
            // A table is a module; its pairs are fields carrying the table name.
            {
                source: "[server]\nhost = \"localhost\"\nport = 8080\n",
                expect: {
                    server: { kind: "module", container: undefined },
                    host: { kind: "field", container: "server" },
                    port: { kind: "field", container: "server" },
                },
            },
            // A dotted table name is one verbatim container segment.
            {
                source: "[database.options]\nname = \"db\"\n",
                expect: { "database.options": { kind: "module" }, name: { kind: "field", container: "database.options" } },
            },
            { source: "[[products]]\nsku = 1\n", expect: { products: { container: undefined }, sku: { container: "products" } } },
        ],
        malformed: ["[[[broken"],
        topLevel: { source: "title = \"t\"\n", expect: { title: { container: undefined, column: 1 } } },
    },
    {
        mimetype: "text/typescript",
        sources: [
            {
                source: "interface Doable {\n  run(x: number): void;\n  ready: boolean;\n}\n",
                expect: { Doable: { kind: "interface" }, run: { kind: "method" }, ready: { kind: "field" } },
            },
            { source: "type Name = string;\n", expect: { Name: { kind: "type" } } },
            { source: "enum Color { Red = 'red', Green = 'green' }\n", expect: { Color: { kind: "enum" }, Red: { kind: "constant" } } },
            {
                source: "namespace ns {\n  export function inner() {}\n  export const X = 1;\n}\n",
                expect: { ns: { kind: "module" }, inner: { kind: "function" }, X: { kind: "constant" } },
            },
            // Shared node types fall through to the JavaScript dispatch.
            {
                source: "function plain() {}\nclass C { foo(x: number) {} }\nconst MAX: number = 1;\n",
                expect: { plain: { kind: "function" }, C: { kind: "class" }, foo: { kind: "method" }, MAX: { kind: "constant" } },
            },
            {
                source: "namespace ns {\n  export class C {\n    m(x: number) {}\n  }\n  export function inner() {}\n}\n",
                expect: { ns: { container: undefined }, C: { container: "ns" }, m: { container: "ns.C" }, inner: { container: "ns" } },
            },
        ],
        malformed: ["interface ((( broken"],
        topLevel: {
            source: "interface Doable {\n  run(x: number): void;\n}\n",
            expect: { Doable: { container: undefined, column: 1 }, run: { container: "Doable" } },
        },
    },
    {
        mimetype: "application/yaml",
        sources: [
            { source: "name: Alice\nage: 30\n", expect: { name: { kind: "field" }, age: { kind: "field" } } },
            {
                source: "server:\n  host: localhost\n  port: 8080\n",
                expect: { server: { kind: "field" }, host: { kind: "field" }, port: { kind: "field" } },
            },
            // Nested keys carry the dotted path of enclosing emitted keys.
            {
                source: "server:\n  host: localhost\n  opts:\n    deep: 1\n",
                expect: { server: { container: undefined }, host: { container: "server" }, opts: { container: "server" }, deep: { container: "server.opts" } },
            },
        ],
        malformed: ["::::"],
        topLevel: { source: "name: Alice\n", expect: { name: { container: undefined, column: 1 } } },
    },
    {
        mimetype: "text/x-zig",
        sources: [
            { source: "pub fn add(a: i32, b: i32) i32 { return a + b; }\n", expect: { add: { kind: "function", params: ["a", "b"] } } },
            { source: "const Point = struct { x: i32, y: i32 };\n", expect: { Point: { kind: "class" }, x: { kind: "field" }, y: { kind: "field" } } },
            { source: "const Color = enum { red, green };\n", expect: { Color: { kind: "enum" }, red: { kind: "constant" } } },
            { source: "pub const MAX = 100;\nconst x = 1;\n", expect: { MAX: { kind: "constant" }, x: { kind: "variable" } } },
            {
                source: "const Point = struct { x: f32, y: f32 };\nconst Color = enum { red, green };\n",
                expect: { Point: { container: undefined }, x: { container: "Point" }, y: { container: "Point" }, red: { container: "Color" } },
            },
        ],
        malformed: ["fn ((( broken"],
        topLevel: { source: "fn solo() void {}\n", expect: { solo: { container: undefined, column: 1 } } },
    },
];

function handlerFor(mimetype: string): TreeSitterLanguageHandler {
    const entry = lookupTreeSitterLanguage(mimetype);
    assert.ok(entry, `${mimetype} is a registered tree-sitter language`);
    return new TreeSitterLanguageHandler({ mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions }, entry);
}

function emitted(symbols: MimeSymbol[]): string {
    return symbols.map((s) => `${s.kind} ${s.name}`).join(", ");
}

function check(mimetype: string, snippet: Snippet, symbols: MimeSymbol[]): void {
    const where = `${mimetype} ${JSON.stringify(snippet.source)}`;
    for (const [name, expectation] of Object.entries(snippet.expect ?? {})) {
        const symbol = symbols.find((s) => s.name === name && (expectation.kind === undefined || s.kind === expectation.kind));
        assert.ok(symbol, `${where}: expected ${expectation.kind ?? "a symbol"} ${name}; emitted ${emitted(symbols)}`);
        if (expectation.params !== undefined) assert.deepEqual(symbol.params, expectation.params, `${where}: params of ${name}`);
        if ("container" in expectation) assert.equal(symbol.container, expectation.container, `${where}: container of ${name}`);
        if (expectation.line !== undefined) assert.equal(symbol.line, expectation.line, `${where}: line of ${name}`);
        if (expectation.endLine !== undefined) assert.equal(symbol.endLine, expectation.endLine, `${where}: endLine of ${name}`);
        if (expectation.column !== undefined) {
            assert.equal(symbol.column, expectation.column, `${where}: column of ${name}`);
            assert.ok((symbol.endColumn ?? 0) >= 1, `${where}: endColumn of ${name}`);
        }
        if (expectation.endColumn !== undefined) assert.equal(symbol.endColumn, expectation.endColumn, `${where}: endColumn of ${name}`);
    }
    for (const name of snippet.absent ?? []) {
        assert.equal(symbols.find((s) => s.name === name), undefined, `${where}: ${name} is not a symbol`);
    }
    if (snippet.flat) {
        assert.ok(symbols.length > 0, `${where}: emits symbols`);
        assert.ok(symbols.every((s) => s.container === undefined), `${where}: no symbol carries a container`);
    }
    snippet.also?.(symbols);
}

describe("{§mimetype-symbol} tree-sitter language matrix", () => {
    for (const language of LANGUAGES) {
        it(`{§mimetype-symbol} ${language.mimetype} maps its declarations to symbol kinds`, async () => {
            const handler = handlerFor(language.mimetype);
            for (const snippet of language.sources) {
                check(language.mimetype, snippet, await handler.extractRaw(snippet.source));
            }
        });
        for (const witness of language.also ?? []) {
            it(witness.title, () => witness.run(() => handlerFor(language.mimetype)));
        }
    }

    it("{§mimetype-symbol} every language returns [] for empty input", async () => {
        for (const language of LANGUAGES) {
            assert.deepEqual(await handlerFor(language.mimetype).extractRaw(""), [], language.mimetype);
        }
    });

    it("{§mimetype-symbol} no language throws on malformed source", async () => {
        for (const language of LANGUAGES) {
            const handler = handlerFor(language.mimetype);
            for (const source of language.malformed) {
                await assert.doesNotReject(handler.extractRaw(source), `${language.mimetype} ${JSON.stringify(source)}`);
            }
        }
    });

    it("{§mimetype-symbol-container} top-level symbols carry no container and 1-indexed columns, in every language", async () => {
        for (const language of LANGUAGES) {
            check(language.mimetype, language.topLevel, await handlerFor(language.mimetype).extractRaw(language.topLevel.source));
        }
    });
});
