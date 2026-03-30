import { testLanguage } from "../../lib/testutil.js";

await testLanguage("vhdl", {
	examplesDir: "vendor/grammars-v4/vhdl/vhdl/examples",
	extensions: [".vhd", ".vhdl"],
});
