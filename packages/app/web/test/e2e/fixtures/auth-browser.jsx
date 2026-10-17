import React from "react";
import { createRoot } from "react-dom/client";
import App from "../../../src/App.jsx";
import { usePortalAuth } from "../../../src/auth/use-portal-auth.js";

// Keep the real network and hook. Act must span the delayed response, not an
// already-false negative assertion before React has processed its completion.
const admissionReads = [];
const realFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
    const input = args[0];
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, window.location.href);
    if (!url.pathname.endsWith("/api/auth/me")) return realFetch(...args);
    const read = Promise.withResolvers();
    admissionReads.push(read.promise);
    try {
        const response = await realFetch(...args);
        const json = response.json.bind(response);
        response.json = async () => {
            try { return await json(); }
            finally { read.resolve(); }
        };
        if (!response.ok) read.resolve();
        return response;
    } catch (error) {
        read.resolve();
        throw error;
    }
};
window.__authFixture.flushAdmission = async (number) => {
    const read = admissionReads[number - 1];
    if (!read) throw new Error(`Admission request ${number} has not started.`);
    const previous = window.IS_REACT_ACT_ENVIRONMENT;
    window.IS_REACT_ACT_ENVIRONMENT = true;
    try {
        await React.act(async () => {
            window.__authFixture.flushingAdmission = number;
            await read;
        });
    } finally {
        window.IS_REACT_ACT_ENVIRONMENT = previous;
        delete window.__authFixture.flushingAdmission;
    }
};

function AuthHarness() {
    const [config, setConfig] = React.useState(() => window.__authFixture.config);
    const auth = usePortalAuth(config, window.__authFixture.basePath ?? "/");
    React.useEffect(() => {
        window.__authFixture.current = auth;
        window.__authFixture.setConfig = setConfig;
        (window.__authFixture.states ??= []).push({
            provider: auth.provider, loading: auth.loading, signedIn: auth.signedIn,
            principal: auth.principal,
        });
    }, [auth]);
    return <output data-testid="auth-state">{JSON.stringify({
        loading: auth.loading,
        signedIn: auth.signedIn,
        forbidden: auth.forbidden,
        account: auth.account,
        accessToken: auth.accessToken,
        principal: auth.principal,
        authorization: auth.authorization,
        error: auth.error,
        actionError: auth.actionError,
        actionNotice: auth.actionNotice,
    })}</output>;
}

const root = createRoot(document.getElementById("root"));
window.__authFixture.unmount = () => root.unmount();
root.render(
    window.__authFixture.view === "app" ? <App /> : <AuthHarness />,
);
