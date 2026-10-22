import React from "react";
import { createNoBrowserAuthProvider } from "./providers/none.js";
import { createEntraBrowserAuthProvider } from "./providers/entra.js";
import { createDevBrowserAuthProvider } from "./providers/dev.js";
import { createProxyBrowserAuthProvider } from "./providers/proxy.js";
import { fetchRequestAuthContext } from "./proxy-auth.js";
import { createPortalPaths, getBrowserPortalPaths } from "../../portal-paths.js";

function buildInitialState(authConfig) {
    return {
        loading: true,
        provider: authConfig?.provider || "none",
        authEnabled: Boolean(authConfig?.enabled),
        signedIn: false,
        forbidden: false,
        account: null,
        accessToken: null,
        principal: null,
        authorization: null,
        error: null,
        config: authConfig || null,
    };
}

function createBrowserAuthProvider(providerId) {
    if (!providerId || providerId === "none") return createNoBrowserAuthProvider();
    if (providerId === "entra") return createEntraBrowserAuthProvider();
    if (providerId === "dev") return createDevBrowserAuthProvider();
    if (providerId === "proxy") return createProxyBrowserAuthProvider();
    return null;
}

async function readAuthErrorMessage(response) {
    try {
        const payload = await response.json();
        return payload?.error || payload?.message || response.statusText;
    } catch {
        return response.statusText || `HTTP ${response.status}`;
    }
}

async function fetchAuthContext(token, paths) {
    const headers = new Headers();
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await fetch(paths.path("/api/auth/me"), { headers });
    if (response.status === 401) {
        return {
            status: "unauthorized",
            error: "Unauthorized",
        };
    }
    if (response.status === 403) {
        return {
            status: "forbidden",
            error: await readAuthErrorMessage(response),
        };
    }
    if (!response.ok) {
        throw new Error(await readAuthErrorMessage(response));
    }
    const payload = await response.json();
    return {
        status: "authorized",
        principal: payload?.principal || null,
        authorization: payload?.authorization || null,
    };
}

export function usePortalAuth(authConfig, basePath = getBrowserPortalPaths().basePath) {
    const paths = React.useMemo(() => createPortalPaths(basePath), [basePath]);
    const [state, setState] = React.useState(() => buildInitialState(authConfig));
    const providerRef = React.useRef(null);
    const requestGeneration = React.useRef(0);
    const requestScope = React.useMemo(() => ({ authConfig, paths }), [authConfig, paths]);
    const requestScopeRef = React.useRef(requestScope);
    const initializedRequestScope = React.useRef(null);
    const proxyEpoch = React.useRef(0);
    if (requestScopeRef.current !== requestScope
        && (authConfig?.provider === "proxy" || requestScopeRef.current.authConfig?.provider === "proxy")) {
        ++proxyEpoch.current;
    }
    requestScopeRef.current = requestScope;

    const syncRequestAuth = React.useCallback(async (provider, scope) => {
        const generation = ++requestGeneration.current;
        const current = () => requestGeneration.current === generation
            && requestScopeRef.current === scope && providerRef.current === provider;
        setState({ ...buildInitialState(scope.authConfig), requestAuth: true });
        let result;
        try {
            await provider.initialize(scope.authConfig, scope.paths.basePath);
            if (!current()) return;
            initializedRequestScope.current = scope;
            result = await fetchRequestAuthContext(scope.paths);
        } catch (error) {
            result = { status: "error", error: error?.message || String(error) };
        }
        if (!current()) return;
        setState({
            ...buildInitialState(scope.authConfig),
            loading: false,
            requestAuth: true,
            signedIn: result.status === "authorized",
            forbidden: result.status === "forbidden",
            principal: result.status === "authorized" ? result.principal : null,
            authorization: result.status === "authorized" ? result.authorization : null,
            error: result.error || null,
        });
    }, []);

    const applyAuthorizedState = React.useCallback(({ account, accessToken, principal, authorization }) => {
        setState((current) => ({
            ...current,
            loading: false,
            signedIn: true,
            forbidden: false,
            account,
            accessToken: accessToken ?? current.accessToken ?? null,
            principal: principal ?? null,
            authorization: authorization ?? null,
            error: null,
        }));
    }, []);

    const applyForbiddenState = React.useCallback(({ account, accessToken, error }) => {
        setState((current) => ({
            ...current,
            loading: false,
            signedIn: Boolean(account),
            forbidden: true,
            account: account ?? current.account ?? null,
            accessToken: accessToken ?? current.accessToken ?? null,
            principal: null,
            authorization: null,
            error: error || "This account is not authorized to access the portal.",
        }));
    }, []);

    const syncAuthContext = React.useCallback(async ({ account, accessToken }) => {
        const epoch = proxyEpoch.current;
        const result = await fetchAuthContext(accessToken, paths);
        if (epoch !== proxyEpoch.current) return { status: "stale" };
        if (result.status === "authorized") {
            applyAuthorizedState({
                account,
                accessToken,
                principal: result.principal,
                authorization: result.authorization,
            });
            return result;
        }
        if (result.status === "forbidden") {
            applyForbiddenState({
                account,
                accessToken,
                error: result.error,
            });
            return result;
        }
        setState((current) => ({
            ...current,
            loading: false,
            signedIn: false,
            forbidden: false,
            account: null,
            accessToken: null,
            principal: null,
            authorization: null,
            error: null,
        }));
        return result;
    }, [applyAuthorizedState, applyForbiddenState, paths]);

    React.useEffect(() => {
        let active = true;
        ++requestGeneration.current;
        initializedRequestScope.current = null;

        async function initialize() {
            if (!authConfig) {
                setState((current) => ({ ...current, loading: true }));
                return;
            }

            const provider = createBrowserAuthProvider(authConfig.provider);
            if (!provider) {
                providerRef.current = null;
                if (!active) return;
                setState({
                    loading: false,
                    provider: authConfig.provider,
                    authEnabled: true,
                    signedIn: false,
                    forbidden: false,
                    account: null,
                    accessToken: null,
                    principal: null,
                    authorization: null,
                    error: `Unsupported portal auth provider "${authConfig.provider}"`,
                    config: authConfig,
                });
                return;
            }

            providerRef.current = provider;

            if (!authConfig.enabled && authConfig.provider && authConfig.provider !== "none") {
                if (!active) return;
                setState({
                    loading: false,
                    provider: authConfig.provider,
                    authEnabled: true,
                    signedIn: false,
                    forbidden: false,
                    account: null,
                    accessToken: null,
                    principal: null,
                    authorization: null,
                    error: `Portal auth provider "${authConfig.provider}" is selected but not fully configured.`,
                    config: authConfig,
                });
                return;
            }

            if (!authConfig.enabled || authConfig.provider === "none") {
                try {
                    await provider.initialize(authConfig);
                    const result = await fetchAuthContext(null, paths);
                    if (!active) return;
                    if (result.status === "authorized") {
                        setState({
                            loading: false,
                            provider: authConfig.provider || "none",
                            authEnabled: false,
                            signedIn: true,
                            forbidden: false,
                            account: null,
                            accessToken: null,
                            principal: result.principal || null,
                            authorization: result.authorization || null,
                            error: null,
                            config: authConfig,
                        });
                        return;
                    }
                    setState({
                        loading: false,
                        provider: authConfig.provider || "none",
                        authEnabled: false,
                        signedIn: false,
                        forbidden: result.status === "forbidden",
                        account: null,
                        accessToken: null,
                        principal: null,
                        authorization: null,
                        error: result.error || null,
                        config: authConfig,
                    });
                } catch (error) {
                    if (!active) return;
                    setState({
                        loading: false,
                        provider: authConfig.provider || "none",
                        authEnabled: false,
                        signedIn: false,
                        forbidden: false,
                        account: null,
                        accessToken: null,
                        principal: null,
                        authorization: null,
                        error: error?.message || String(error),
                        config: authConfig,
                    });
                }
                return;
            }

            if (provider.authenticatesFromRequest === true) {
                await syncRequestAuth(provider, requestScope);
                return;
            }

            try {
                const initialized = await provider.initialize(authConfig);
                const account = initialized?.account || provider.getAccount() || null;
                const accessToken = initialized?.accessToken || null;
                if (!active) return;
                if (!account) {
                    setState({
                        loading: false,
                        provider: authConfig.provider,
                        authEnabled: true,
                        signedIn: false,
                        forbidden: false,
                        account: null,
                        accessToken: null,
                        principal: null,
                        authorization: null,
                        error: null,
                        config: authConfig,
                    });
                    return;
                }

                // A reload restores the ACCOUNT from the MSAL cache before a
                // token is necessarily available: initialize() acquires
                // silently, and a silent acquire that needs interaction just
                // returns null. Without a bearer token /api/auth/me can only
                // answer 401, and the browser logs every failed request — so
                // that guaranteed-doomed probe showed up as a console error on
                // EVERY load. Skip it and take the same unauthorized branch it
                // would have produced. A 401 that survives this is a real one:
                // a token the server actually rejected.
                const result = accessToken
                    ? await fetchAuthContext(accessToken, paths)
                    : { status: "unauthorized", error: "Unauthorized" };
                if (!active) return;
                if (result.status === "authorized") {
                    setState({
                        loading: false,
                        provider: authConfig.provider,
                        authEnabled: true,
                        signedIn: true,
                        forbidden: false,
                        account,
                        accessToken,
                        principal: result.principal || null,
                        authorization: result.authorization || null,
                        error: null,
                        config: authConfig,
                    });
                    return;
                }

                setState({
                    loading: false,
                    provider: authConfig.provider,
                    authEnabled: true,
                    signedIn: Boolean(account),
                    forbidden: result.status === "forbidden",
                    account,
                    accessToken,
                    principal: null,
                    authorization: null,
                    error: result.error || null,
                    config: authConfig,
                });
            } catch (error) {
                if (!active) return;
                setState({
                    loading: false,
                    provider: authConfig.provider,
                    authEnabled: true,
                    signedIn: false,
                    forbidden: false,
                    account: null,
                    accessToken: null,
                    principal: null,
                    authorization: null,
                    error: error?.message || String(error),
                    config: authConfig,
                });
            }
        }

        initialize();
        return () => {
            active = false;
            ++requestGeneration.current;
        };
    }, [
        authConfig?.client?.authority,
        authConfig?.client?.clientId,
        authConfig?.client?.redirectUri,
        authConfig?.enabled,
        authConfig?.provider,
        authConfig?.provider === "proxy" ? requestScope : null,
        paths,
        syncAuthContext,
        syncRequestAuth,
    ]);

    const signIn = React.useCallback(async (signInArg) => {
        if (!state.authEnabled) return;
        if (!providerRef.current) {
            throw new Error(`Unsupported portal auth provider "${state.provider}"`);
        }

        if (providerRef.current.authenticatesFromRequest === true) {
            const provider = providerRef.current;
            const scope = requestScopeRef.current;
            const generation = ++requestGeneration.current;
            try {
                if (!scope.authConfig?.client?.signInUrl) {
                    await syncRequestAuth(provider, scope);
                    return;
                }
                if (initializedRequestScope.current !== scope) throw new Error("Proxy sign-in configuration is not ready. Retry after it loads.");
                await provider.signIn();
            } catch (error) {
                if (generation !== requestGeneration.current || scope !== requestScopeRef.current) return;
                setState((current) => ({
                    ...current, loading: false, actionError: error?.message || String(error),
                }));
            }
            return;
        }

        // signInArg is provider-specific (the dev provider takes a persona id);
        // none/entra ignore it.
        const epoch = proxyEpoch.current;
        const result = await providerRef.current.signIn(signInArg);
        if (epoch !== proxyEpoch.current) return;
        if (result?.redirected) return;

        const account = result?.account || providerRef.current.getAccount() || null;
        const accessToken = result?.accessToken || await providerRef.current.getAccessToken();
        if (epoch !== proxyEpoch.current) return;

        if (!account) {
            setState((current) => ({
                ...current,
                signedIn: false,
                forbidden: false,
                account: null,
                accessToken: null,
                principal: null,
                authorization: null,
                error: null,
            }));
            return;
        }

        await syncAuthContext({ account, accessToken });
    }, [state.authEnabled, state.provider, syncAuthContext, syncRequestAuth]);

    const signOut = React.useCallback(async () => {
        if (providerRef.current?.authenticatesFromRequest === true) {
            const scope = requestScopeRef.current;
            const generation = ++requestGeneration.current;
            try {
                if (initializedRequestScope.current !== scope) throw new Error("Proxy sign-out configuration is not ready. Retry after it loads.");
                const result = await providerRef.current.signOut();
                if (generation !== requestGeneration.current || scope !== requestScopeRef.current) return;
                if (result?.upstreamManaged) {
                    setState((current) => ({
                        ...current, loading: false, actionError: null,
                        actionNotice: "Sign-out is managed by the upstream proxy. This portal has not signed you out.",
                    }));
                }
            } catch (error) {
                if (generation !== requestGeneration.current || scope !== requestScopeRef.current) return;
                setState((current) => ({
                    ...current, loading: false, actionError: error?.message || String(error),
                }));
            }
            return;
        }
        if (!providerRef.current) {
            setState((current) => ({
                ...current,
                signedIn: false,
                forbidden: false,
                account: null,
                accessToken: null,
                principal: null,
                authorization: null,
            }));
            return;
        }

        const epoch = proxyEpoch.current;
        const result = await providerRef.current.signOut();
        if (epoch !== proxyEpoch.current) return;
        if (result?.redirected) return;

        setState((current) => ({
            ...current,
            signedIn: false,
            forbidden: false,
            account: null,
            accessToken: null,
            principal: null,
            authorization: null,
            error: null,
        }));
    }, []);

    const handleUnauthorized = React.useCallback(() => {
        ++requestGeneration.current;
        setState((current) => ({
            ...current,
            ...(current.requestAuth ? { loading: false, actionError: null, actionNotice: null } : {}),
            signedIn: false,
            forbidden: false,
            account: null,
            accessToken: null,
            principal: null,
            authorization: null,
            error: null,
        }));
    }, []);

    const handleForbidden = React.useCallback((error) => {
        ++requestGeneration.current;
        setState((current) => ({
            ...current,
            ...(current.requestAuth ? { loading: false, signedIn: false, account: null, accessToken: null, actionError: null, actionNotice: null } : {}),
            forbidden: true,
            principal: null,
            authorization: null,
            error: error || "This account is not authorized to access the portal.",
        }));
    }, []);

    const getAccessToken = React.useCallback(async () => {
        if (!state.authEnabled) return null;
        if (!providerRef.current) {
            throw new Error(`Unsupported portal auth provider "${state.provider}"`);
        }
        // Delegate straight to the provider so MSAL can silently refresh the
        // access token from its refresh token. Returning the token cached in
        // React state here would pin the session to the original ~1h
        // access-token lifetime and force a logout the moment it expired.
        return providerRef.current.getAccessToken();
    }, [state.authEnabled, state.provider]);

    /** Token for a non-portal resource (Azure DevOps) — client-side repo reads. */
    const getResourceToken = React.useCallback(async (resource) => {
        if (!state.authEnabled || !providerRef.current?.getResourceToken) return null;
        return providerRef.current.getResourceToken(resource);
    }, [state.authEnabled]);

    // Never expose an older anonymous/token identity during a proxy config switch.
    const visibleState = (authConfig?.provider === "proxy" || state.provider === "proxy")
        && state.config !== authConfig ? buildInitialState(authConfig) : state;
    return {
        ...visibleState,
        signIn,
        signOut,
        getAccessToken,
        getResourceToken,
        handleUnauthorized,
        handleForbidden,
    };
}
