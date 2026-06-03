import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TreeSitterLanguageHandler from "./handler.ts";
import { lookupTreeSitterLanguage } from "./registry.ts";

const entry = lookupTreeSitterLanguage("text/x-elixir")!;
const md = { mimetype: entry.mimetype, glyph: entry.glyph, extensions: entry.extensions };
const h = () => new TreeSitterLanguageHandler(md, entry);

describe("text/x-elixir via tree-sitter registry", () => {
    it("defmodule → module + nested def → function", async () => {
        const src = "defmodule MyApp.User do\n  def greet(name) do\n    name\n  end\nend\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "MyApp.User")?.kind, "module");
        const greet = syms.find((s) => s.name === "greet");
        assert.equal(greet?.kind, "function");
        assert.deepEqual(greet?.params, ["name"]);
    });

    it("defp → function (private treated structurally as function)", async () => {
        const src = "defmodule M do\n  defp helper(x), do: x\nend\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "helper")?.kind, "function");
    });

    it("defmacro → function", async () => {
        const src = "defmodule M do\n  defmacro unless(cond, do: body) do\n    quote do: if !unquote(cond), do: unquote(body)\n  end\nend\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "unless")?.kind, "function");
    });

    it("zero-arity function", async () => {
        const src = "defmodule M do\n  def version, do: \"1.0\"\nend\n";
        const syms = await h().extractRaw(src);
        const v = syms.find((s) => s.name === "version");
        assert.equal(v?.kind, "function");
        assert.deepEqual(v?.params, []);
    });

    it("guarded function (when clause)", async () => {
        const src = "defmodule M do\n  def positive?(n) when n > 0, do: true\nend\n";
        const syms = await h().extractRaw(src);
        assert.equal(syms.find((s) => s.name === "positive?")?.kind, "function");
    });

    it("returns [] for empty input", async () => {
        assert.deepEqual(await h().extractRaw(""), []);
    });

    it("does not throw on malformed source", async () => {
        await assert.doesNotReject(h().extractRaw("defmodule ((( broken"));
    });
});
