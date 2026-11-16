import React from "react";

// Keep the listener in the shell: the console unmounts on toolbar/new-session
// exits, but its browser entries still need to be unwound.
export function useMobileAdminNavigation(controller, mobile, visible) {
    const token = React.useRef(null);
    const [path, setPath] = React.useState([]);
    const historyRef = React.useRef({ active: false, rewinding: false, pendingBack: false,
        rewindStarted: false, rewindId: 0, baseKey: null, path: [] });
    const mounted = React.useRef(false);
    const wanted = React.useRef(false);
    wanted.current = mobile && visible;
    const publish = React.useCallback(next => {
        historyRef.current.path = next;
        setPath(next);
        const section = next[1]?.section;
        if (section) controller.setAdminSection(section);
        if (next.length === 2 && section === "packages") void controller.selectAdminPackage(null);
        const pkg = next[2], file = next[3];
        if (pkg?.kind === "package") {
            const selected = controller.getState().admin.packages;
            const restoreFile = () => {
                if (historyRef.current.active && historyRef.current.path === next && file?.kind === "file"
                    && controller.getState().admin.packages.workspace.selectedPath !== file.path)
                    void controller.selectAdminPackageFile(file.path);
            };
            const sameCopy = selected.selectedSelector?.scope === pkg.selector.scope
                && selected.selectedSelector?.owner?.provider === pkg.selector.owner?.provider
                && selected.selectedSelector?.owner?.subject === pkg.selector.owner?.subject;
            if (selected.selectedName !== pkg.name || !sameCopy)
                void controller.selectAdminPackage(pkg.name, pkg.selector).then(restoreFile);
            else restoreFile();
        }
    }, [controller]);
    const begin = React.useCallback(() => {
        const current = historyRef.current;
        if (current.active || current.rewinding || !wanted.current) return;
        current.active = true;
        current.baseKey = window.navigation?.currentEntry?.key || null;
        const next = [{ kind: "settings" }];
        token.current ||= Array.from(window.crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join("-");
        window.history.pushState({ ...window.history.state, psMobileAdmin: { token: token.current, path: next } }, "");
        publish(next);
    }, [publish, token]);
    const finishRewind = React.useCallback(() => {
        const current = historyRef.current;
        current.rewinding = false;
        current.pendingBack = false;
        begin();
    }, [begin]);
    const rewind = React.useCallback((depth, attempt = 0) => {
        const current = historyRef.current;
        current.rewindStarted = true;
        const api = window.navigation;
        const entries = api?.entries();
        const key = current.baseKey || entries?.find(entry => entry.index === api.currentEntry.index - depth)?.key;
        if (key && entries?.some(entry => entry.key === key)) {
            // An absolute destination cannot overshoot when a native Back is
            // already pending. Relative go(-depth) adds to that traversal.
            const id = ++current.rewindId;
            void api.traverseTo(key).finished.then(() => {
                if (mounted.current && current.rewinding && current.rewindId === id
                    && api.currentEntry.key === key) finishRewind();
            }, error => {
                if (!mounted.current || !current.rewinding || current.rewindId !== id) return;
                if (error.name === "AbortError") {
                    // Another navigation interrupted the rewind. Once it lands,
                    // either we already left the console's entries, or we
                    // retry; never stay "rewinding", which blocks reopening.
                    const settle = () => {
                        if (!mounted.current || !current.rewinding || current.rewindId !== id) return;
                        const entry = window.history.state?.psMobileAdmin;
                        if (entry?.token === token.current && attempt < 2) rewind(entry.path.length, attempt + 1);
                        else finishRewind();
                    };
                    const landing = api.transition?.finished;
                    if (landing) landing.then(settle, settle);
                    else settle();
                    return;
                }
                console.error("Could not restore the page before the phone console.", error);
                finishRewind();
            });
        } else if (depth > 0) {
            window.history.go(-Math.min(depth, window.history.length - 1));
        } else finishRewind();
    }, [finishRewind]);
    React.useEffect(() => {
        mounted.current = true;
        const pop = event => {
            const current = historyRef.current;
            current.pendingBack = false;
            if (current.rewinding) {
                if (event.state?.psMobileAdmin?.token === token.current) {
                    if (!current.rewindStarted) rewind(event.state.psMobileAdmin.path.length);
                } else finishRewind();
                return;
            }
            if (!current.active) return;
            const entry = event.state?.psMobileAdmin;
            if (entry?.token === token.current) publish(entry.path);
            else {
                current.active = false;
                publish([]);
                controller.closeAdminConsole();
            }
        };
        window.addEventListener("popstate", pop);
        const stale = window.history.state?.psMobileAdmin;
        if (!historyRef.current.active && !historyRef.current.rewinding && stale && stale.token !== token.current) {
            const depth = Math.min(stale.path?.length || 0, window.history.length - 1);
            if (depth > 0) {
                historyRef.current.rewinding = true;
                rewind(depth);
            } else {
                const { psMobileAdmin: _stale, ...state } = window.history.state;
                window.history.replaceState(state, "");
            }
        }
        return () => {
            mounted.current = false;
            window.removeEventListener("popstate", pop);
        };
    }, [controller, finishRewind, publish, rewind, token]);
    React.useEffect(() => {
        const current = historyRef.current;
        if (mobile && visible) begin();
        else if (current.active) {
            // Return to the entry that preceded the console. Forward entries
            // are inert and a later open truncates them, rather than trapping
            // Back behind a closed console.
            const entry = window.history.state?.psMobileAdmin;
            const entries = entry?.token === token.current
                ? Math.min(entry.path.length, window.history.length - 1) : 0;
            current.active = false;
            current.rewinding = entries > 0;
            current.rewindStarted = false;
            publish([]);
            if (entries > 0 && (!current.pendingBack || window.navigation)) rewind(entries);
        }
    }, [begin, mobile, publish, rewind, visible]);
    const drill = React.useCallback(step => {
        const current = historyRef.current;
        if (!current.active || current.rewinding) return;
        const next = [...current.path, step];
        window.history.pushState({ ...window.history.state, psMobileAdmin: { token: token.current, path: next } }, "");
        publish(next);
    }, [publish, token]);
    const back = React.useCallback(expectedPath => {
        const current = historyRef.current;
        if (current.active && !current.rewinding && !current.pendingBack
            && (!Array.isArray(expectedPath) || current.path === expectedPath)) {
            current.pendingBack = true;
            window.history.back();
        }
    }, []);
    return { path, drill, back };
}

export function useMobileAdminOverlay(navigation, enabled, open, id, onClose) {
    const tracked = React.useRef(false);
    const close = React.useRef(onClose);
    close.current = onClose;
    React.useEffect(() => {
        const entry = navigation.path.at(-1);
        const ownEntry = entry?.kind === "overlay" && entry.id === id;
        if (!enabled) {
            if (tracked.current && open) close.current();
            tracked.current = false;
        } else if (open && !tracked.current && navigation.path.length) {
            tracked.current = true;
            navigation.drill({ kind: "overlay", id });
        } else if (tracked.current && !open) {
            tracked.current = false;
            if (ownEntry) navigation.back(navigation.path);
        } else if (tracked.current && !navigation.path.some(step => step.kind === "overlay" && step.id === id)) {
            tracked.current = false;
            close.current();
        } else if (!tracked.current && !open && ownEntry) {
            navigation.back(navigation.path);
        }
    }, [navigation.path, navigation.drill, navigation.back, enabled, open, id]);
}
