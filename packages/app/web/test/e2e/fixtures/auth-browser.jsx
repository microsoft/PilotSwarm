import React from "react";
import { createRoot } from "react-dom/client";
import App from "../../../src/App.jsx";
import { usePortalAuth } from "../../../src/auth/use-portal-auth.js";

function AuthHarness() {
    const auth = usePortalAuth(window.__authFixture.config);
    React.useEffect(() => {
        window.__authFixture.current = auth;
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
    })}</output>;
}

createRoot(document.getElementById("root")).render(
    window.__authFixture.view === "app" ? <App /> : <AuthHarness />,
);
