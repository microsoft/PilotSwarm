// Only the test Vite server aliases MSAL. The actual Entra provider, hook and
// App remain unmodified; this fixture never enters the production bundle.
function record(method, input) {
    window.__authFixture.calls.push({ method, input });
}

export class PublicClientApplication {
    constructor(config) { record("constructor", config); }
    async initialize() { record("initialize"); }
    async handleRedirectPromise() {
        record("handleRedirectPromise");
        return window.__authFixture.redirectResult ?? null;
    }
    getAllAccounts() {
        record("getAllAccounts");
        return window.__authFixture.accounts ?? [];
    }
    async acquireTokenSilent(input) {
        record("acquireTokenSilent", input);
        if (window.__authFixture.silentFailure) throw new Error("fixture_interaction_required");
        return { accessToken: window.__authFixture.token ?? "fixture-entra-initial" };
    }
    async acquireTokenPopup(input) {
        record("acquireTokenPopup", input);
        return { accessToken: "fixture-entra-interactive" };
    }
    async acquireTokenRedirect(input) { record("acquireTokenRedirect", input); }
    async loginPopup(input) {
        record("loginPopup", input);
        return { account: window.__authFixture.loginAccount };
    }
    async loginRedirect(input) { record("loginRedirect", input); }
    async logoutPopup(input) { record("logoutPopup", input); }
    async logoutRedirect(input) { record("logoutRedirect", input); }
}
