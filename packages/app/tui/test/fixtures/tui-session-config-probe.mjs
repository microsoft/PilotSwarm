// Runs the public TUI host with the real ui-core store and reducer, records what the host restored from config.json,
// applies the given actions, and reports the config file the host wrote. Every renderer and transport is a stub; the
// config directory comes from XDG_CONFIG_HOME, which the test points into its own scratch folder.
import fs from "node:fs";
import path from "node:path";
import { mock } from "node:test";

const { config, actions, configFile } = JSON.parse(process.argv[2]);
const rendered = Promise.withResolvers();
const realCore = await import("pilotswarm/ui-core");
let store = null;

mock.module("duroxide", { namedExports: { initTracing() {} } });
mock.module("react", { defaultExport: { createElement: (component, props) => ({ component, props }) } });
mock.module("ink", {
    namedExports: {
        render(element) {
            rendered.resolve(element.props);
            return { clear() {}, unmount() {}, cleanup() {} };
        },
    },
});
mock.module(new URL("../../src/app.js", import.meta.url).href, { namedExports: { PilotSwarmTuiApp() {} } });
mock.module(new URL("../../src/platform.js", import.meta.url).href, { namedExports: { createTuiPlatform: () => ({}) } });
mock.module(new URL("../../src/node-sdk-transport.js", import.meta.url).href, { namedExports: { NodeSdkTransport: class {} } });
mock.module("pilotswarm/ui-core", {
    namedExports: {
        ...realCore,
        PilotSwarmUiController: class {
            constructor(options) { store = options.store; }
            setViewport() {}
            async stop() {}
        },
    },
});
mock.method(process, "exit", () => {});

const { startTuiApp } = await import("pilotswarm");
const startup = startTuiApp(config);
const props = await rendered.promise;
const restored = {
    openTerminatedIds: [...store.getState().sessions.openTerminatedIds].sort(),
    collapsedIds: [...store.getState().sessions.collapsedIds].sort(),
};
for (const action of actions) store.dispatch(action);
const written = JSON.parse(fs.readFileSync(path.resolve(configFile), "utf8"));
await props.onRequestExit();
await startup;
process.stdout.write(JSON.stringify({ restored, written }));
