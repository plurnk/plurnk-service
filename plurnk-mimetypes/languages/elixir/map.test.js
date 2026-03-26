import { testLanguage } from "../../lib/testutil.js";

await testLanguage("elixir", {
	examplesDir: "vendor/grammars-v4/elixir/examples",
	extensions: [".ex", ".exs"],
});
