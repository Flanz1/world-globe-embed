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

/**
 * Production build only: a strict Content-Security-Policy for the admin page. GitHub Pages can't send
 * headers, so it goes in a <meta> tag (which can't express frame-ancestors; main.ts refuses to run framed).
 * The dev server is left alone because Vite's client needs inline scripts and a websocket.
 */
export const ADMIN_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src https://api.github.com",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

function adminCsp(): Plugin {
  return {
    name: "admin-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!ctx.filename.endsWith("admin/index.html")) return html;
        return html.replace(/<meta charset="utf-8">/i, (m) => `${m}\n<meta http-equiv="Content-Security-Policy" content="${ADMIN_CSP}">`);
      },
    },
  };
}

export default defineConfig({
  // Relative by default so the same build works on flanz1.github.io/world-globe-embed/ and on a custom domain.
  base: process.env.BASE_PATH || "./",
  define: {
    __REPO__: JSON.stringify(process.env.GITHUB_REPOSITORY || "Flanz1/world-globe-embed"),
  },
  plugins: [devSlotPages(), adminCsp()],
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
