import { defineConfig, type Plugin } from "vite";
import { buildBoot } from "./scripts/lib/build-boot.ts";
import { loadContent } from "./scripts/lib/content.ts";
import { renderLanding } from "./scripts/lib/landing.ts";
import { generateSlotPages } from "./scripts/lib/pages.ts";

/** Dev server only: serves /v/<slug>/ and / from content/ on the fly. */
function devSlotPages(): Plugin {
  return {
    name: "dev-slot-pages",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://x");
        const m = /^\/v\/([a-z0-9-]+)\/?$/.exec(url.pathname);
        if (!m && url.pathname !== "/" && url.pathname !== "/index.html") return next();
        const { content, errors } = loadContent();
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        if (!content) {
          res.statusCode = 500;
          return res.end(`<pre>${errors.join("\n").replace(/</g, "&lt;")}</pre>`);
        }
        if (!m) return res.end(renderLanding(content));
        if (!url.pathname.endsWith("/")) {
          res.statusCode = 302;
          res.setHeader("Location", `${url.pathname}/${url.search}`);
          return res.end();
        }
        const page = generateSlotPages(content, await buildBoot(), "/src/viewer/globe.ts").find(
          (p) => p.path === `v/${m[1]}/index.html`,
        );
        if (!page) return next();
        res.end(page.html);
      });
    },
  };
}

export default defineConfig({
  // Relative by default so the same build works on flanz1.github.io/world-globe-embed/ and on a custom domain.
  base: process.env.BASE_PATH || "./",
  define: {
    __REPO__: JSON.stringify(process.env.GITHUB_REPOSITORY || "Flanz1/world-globe-embed"),
  },
  plugins: [devSlotPages()],
  build: {
    target: "es2022",
    manifest: true,
    modulePreload: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: { globe: "src/viewer/globe.ts", admin: "admin/index.html" },
      preserveEntrySignatures: "exports-only",
      output: { entryFileNames: "assets/[name]-[hash].js" },
    },
  },
});
