import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runConformance } from "./harness.ts";
import TreeSitterLanguageHandler from "../../src/treesitter/handler.ts";
import { lookupTreeSitterLanguage } from "../../src/treesitter/registry.ts";

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

describe("conformance: text/x-tsx refs (SPEC §16)", () => {
    it("typescript refs + JSX component edges; host elements filtered", async () => {
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

    it("lowercase host elements (div, svg) are not refs (capitalization filter)", async () => {
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
