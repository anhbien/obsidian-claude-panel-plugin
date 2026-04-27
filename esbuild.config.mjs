import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const VAULT_PLUGIN_DIR =
  "/Users/anhbien/Library/Mobile Documents/iCloud~md~obsidian/Documents/AB Obsidian Vault - iCloud/.obsidian/plugins/claude-panel";

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: `${VAULT_PLUGIN_DIR}/main.js`,
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
