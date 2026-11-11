import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import license from "rollup-plugin-license";
import { fileURLToPath } from "node:url";

// Third-party notices for everything the portal's browser bundle includes:
// each package's name, version, license and full license text, written next
// to the bundle (dist/THIRD-PARTY-NOTICES.txt), so it ships with the package.
// The template, the elected licenses and the components another package
// bundles inside its own dist live in third-party-notices.js, where a test
// reads them.
import { thirdPartyNotices } from "./third-party-notices.js";

const workspacePackageAlias = {
  "pilotswarm/ui-core": fileURLToPath(new URL("../ui/core/src/index.js", import.meta.url)),
  "pilotswarm/ui-react": fileURLToPath(new URL("../ui/react/src/index.js", import.meta.url)),
  "pilotswarm-sdk/api": fileURLToPath(new URL("../../sdk/api/index.js", import.meta.url)),
};

export default defineConfig({
  plugins: [
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
    proxy: {
      // ws:true forwards the /api/v1/ws WebSocket upgrade to the portal
      // server; it is harmless for the plain HTTP /api/v1 routes. Without it,
      // live session events and the log tail are dead in `npm run dev`.
      "/api": {
        target: "http://localhost:3001",
        ws: true,
      },
      "/portal-ws": {
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
});
