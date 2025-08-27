import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(__dirname, "plugin.js")],
  outfile: path.join(__dirname, "plugin.cjs"),
  platform: "node",
  format: "cjs",
  target: "node20",
  bundle: true,
  minify: true,
  sourcemap: false,

  // Native Addons NICHT bundlen:
  external: ["easymidi", "@napi-rs/canvas", "utf-8-validate", "bufferutil"],

  // ws optional natives deaktivieren (macht das Bundle kleiner/robuster)
  define: {
    "process.env.WS_NO_BUFFER_UTIL": "true",
    "process.env.WS_NO_UTF_8_VALIDATE": "true",
  },
})
  .then(() => {
    console.log("[build] plugin.cjs ready");
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
