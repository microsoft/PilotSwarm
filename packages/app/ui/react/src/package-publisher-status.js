import React from "react";

export function packageApprovalLabel(version) {
    if (version.executable === false) return "not required";
    if (version.decision === "pending") return "pending admin approval";
    if (version.decision === "approved") return version.active ? "active" : "approved (not active)";
    if (["rejected", "revoked"].includes(version.decision)) return version.decision;
    return "pending admin approval";
}

export function PackagePublisherStatus({ transport, packageId, initialStatus = null }) {
    const [status, setStatus] = React.useState(initialStatus);
    const [error, setError] = React.useState(false);
    const [revision, refresh] = React.useReducer(value => value + 1, 0);
    React.useEffect(() => {
        let live = true;
        setStatus(null); setError(false);
        Promise.resolve().then(() => transport.getAgentPackageReviewStatus(packageId))
            .then(value => { if (live) setStatus(value); }, () => { if (live) setError(true); });
        return () => { live = false; };
    }, [transport, packageId, revision]);
    const refreshButton = React.createElement("button", { type: "button", onClick: refresh }, "Refresh approval status");
    if (error) return React.createElement("section", null, React.createElement("p", { role: "status" }, "Approval status unavailable."), refreshButton);
    if (!status) return React.createElement("p", { role: "status" }, "Loading approval status…");
    return React.createElement("section", { "aria-label": "Package approval status" },
        refreshButton,
        status.versions.map(version => React.createElement("div", { key: version.versionId },
            React.createElement("strong", null, `Approval: ${packageApprovalLabel(version)}`),
            React.createElement("div", null, `${version.semver} · ${version.versionId} · sha ${version.sha256}`),
            version.reasons.length ? React.createElement("p", null, version.reasons.join("; ")) : null)));
}
