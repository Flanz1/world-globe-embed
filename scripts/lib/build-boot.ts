import { build } from "esbuild";
import path from "node:path";
import { ROOT } from "./paths.ts";

/** Compiles src/viewer/boot.ts into a small minified IIFE for inlining. */
export async function buildBoot(): Promise<string> {
  const out = await build({
    entryPoints: [path.join(ROOT, "src/viewer/boot.ts")],
    bundle: true,
    format: "iife",
    minify: true,
    target: "es2020",
    write: false,
    legalComments: "none",
  });
  const js = out.outputFiles[0].text.trim();
  if (/<\/script/i.test(js)) throw new Error("boot script contains </script>");
  return js;
}
