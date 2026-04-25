import esbuild from "esbuild";
import builtinModules from "builtin-modules";
import process from "node:process";

const production = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtinModules],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
