import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import license from "rollup-plugin-license";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

// Third-party notices for everything the portal's browser bundle includes:
// each package's name, version, license and full license text, written next
// to the bundle (dist/THIRD-PARTY-NOTICES.txt), so it ships with the package.
// Dual-licensed components, and the license PilotSwarm uses them under.
const ELECTED_LICENSES = { dompurify: "Apache-2.0" };

// Assets that ship in the bundle from the source tree rather than from npm,
// with the full license text each one requires (the SIL OFL asks for its text
// to travel with every copy of the fonts).
const BUNDLED_ASSETS = [
  {
    name: "Sora (fonts for the Horizon Dawn theme)",
    license: "OFL-1.1",
    source: "https://github.com/sora-xor/sora-font",
    licenseFile: new URL("./src/assets/horizon-dawn/Sora-OFL.txt", import.meta.url),
  },
  {
    name: "JetBrains Mono (the portal's monospace font)",
    license: "OFL-1.1",
    source: "https://github.com/JetBrains/JetBrainsMono",
    licenseFile: new URL("./src/assets/fonts/jetbrains-mono/JetBrainsMono-OFL.txt", import.meta.url),
  },
];

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
  const assets = BUNDLED_ASSETS.map((asset) => [
    "=".repeat(78),
    asset.name,
    `License: ${asset.license}`,
    `Source: ${asset.source}`,
    "",
    readFileSync(asset.licenseFile, "utf8").trim(),
    "",
  ].join("\n"));
  return `${header.join("\n")}\n${[...sections, ...assets].join("\n")}\n`;
}

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
