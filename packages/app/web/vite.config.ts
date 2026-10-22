import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import license from "rollup-plugin-license";
import { fileURLToPath } from "node:url";
import { createPortalPaths, isLegacyPortalPath, isPortalNavigationPath, renderPortalShell } from "./portal-paths.js";

// Third-party notices for everything the portal's browser bundle includes:
// each package's name, version, license and full license text, written next
// to the bundle (dist/THIRD-PARTY-NOTICES.txt), so it ships with the package.
// Dual-licensed components, and the license PilotSwarm uses them under.
const ELECTED_LICENSES = { dompurify: "Apache-2.0" };

function thirdPartyNotices(dependencies) {
  const sorted = [...dependencies].sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
  const header = [
    "THIRD-PARTY SOFTWARE NOTICES",
    "",
    "The PilotSwarm web portal includes the following third-party software.",
    "Each component is listed with its license and license text.",
    "",
  ];
  const sections = sorted.map((dependency) => [
    "=".repeat(78),
    `${dependency.name} ${dependency.version}`,
    `License: ${dependency.license || "see below"}`,
    ELECTED_LICENSES[dependency.name] ? `Used under: ${ELECTED_LICENSES[dependency.name]}` : null,
    dependency.repository?.url ? `Source: ${dependency.repository.url}` : null,
    "",
    String(dependency.licenseText || dependency.noticeText || "(no license text in the package)").trim(),
    dependency.noticeText && dependency.licenseText ? `\nNOTICE:\n${String(dependency.noticeText).trim()}` : null,
    "",
  ].filter((line) => line !== null).join("\n"));
  return `${header.join("\n")}\n${sections.join("\n")}\n`;
}

const workspacePackageAlias = {
  "pilotswarm/ui-core": fileURLToPath(new URL("../ui/core/src/index.js", import.meta.url)),
  "pilotswarm/ui-react": fileURLToPath(new URL("../ui/react/src/index.js", import.meta.url)),
  "pilotswarm-sdk/api": fileURLToPath(new URL("../../sdk/api/index.js", import.meta.url)),
};

export default defineConfig(({ command }) => {
  const paths = createPortalPaths(process.env.PORTAL_BASE_PATH);
  const proxyPrefix = (localPath: string) => `^${paths.path(localPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|\\?|$)`;
  return {
    base: command === "serve" ? paths.entryPath : "./",
    publicDir: false,
    appType: "mpa",
    plugins: [
      {
        name: "portal-base-path",
        transformIndexHtml: {
          order: "pre",
          handler: (html) => renderPortalShell(html, command === "serve" ? paths : createPortalPaths("/")),
        },
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const rawUrl = req.url;
            const pathname = paths.requestPath(rawUrl);
            const localPath = paths.localPath(rawUrl);
            if (typeof rawUrl !== "string" || pathname === null || !paths.containsRequest(rawUrl)) {
              res.statusCode = pathname === null ? 400 : 404;
              res.end("Not found");
              return;
            }
            const location = paths.redirect(rawUrl);
            if (location) {
              res.statusCode = 308;
              res.setHeader("Location", location);
              res.end();
              return;
            }
            if (localPath !== null && isLegacyPortalPath(localPath)) {
              res.statusCode = 404;
              res.end("Not found");
              return;
            }
            if (localPath !== null && (req.method === "GET" || req.method === "HEAD") && isPortalNavigationPath(localPath)) {
              req.url = `${paths.path("/index.html")}${rawUrl.slice(pathname.length)}`;
            }
            next();
          });
        },
      },
      react(),
      license({
        // The portal's package.json is one level up (packages/app).
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        thirdParty: {
          includePrivate: false,
          output: {
            file: fileURLToPath(new URL("./dist/THIRD-PARTY-NOTICES.txt", import.meta.url)),
            template: thirdPartyNotices,
          },
        },
      }),
    ],
    resolve: {
      alias: workspacePackageAlias,
    },
    server: {
      port: 5173,
      // Vite joins this HMR endpoint to the configured development base.
      hmr: { path: "__portal_hmr" },
      proxy: {
        // ws:true forwards the /api/v1/ws WebSocket upgrade to the portal
        // server; it is harmless for the plain HTTP /api/v1 routes. Without it,
        // live session events and the log tail are dead in `npm run dev`.
        [proxyPrefix("/api")]: {
          target: "http://localhost:3001",
          ws: true,
        },
        [proxyPrefix("/portal-ws")]: {
          target: "http://localhost:3001",
          ws: true,
        },
      },
    },
    build: {
      outDir: "dist",
      rollupOptions: {
        output: {
          manualChunks: {
            react: ["react", "react-dom"],
            msal: ["@azure/msal-browser"],
            pilotswarm: ["pilotswarm/ui-core", "pilotswarm/ui-react"],
          },
        },
      },
    },
  };
});
