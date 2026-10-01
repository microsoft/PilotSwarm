export function workflowGeneratorTreeRowKey(kind, workflowGeneratorId, workflowRunId, transitionId) {
    if (kind === "generator") return `generator:${workflowGeneratorId}`;
    if (kind === "workflowRun") return `workflowRun:${workflowGeneratorId}:${workflowRunId}`;
    if (kind === "transition") {
        return `transition:${workflowGeneratorId}:${workflowRunId}:${transitionId}`;
    }
    return null;
}

export function workflowGeneratorTreeSelectionKey(selected) {
    return workflowGeneratorTreeRowKey(
        selected?.kind,
        selected?.workflowGeneratorId,
        selected?.workflowRunId,
        selected?.transitionId,
    );
}

export function buildVisibleWorkflowGeneratorTreeRows(
    generators,
    expandedGeneratorIds,
    expandedWorkflowRunIds,
) {
    const rows = [];
    for (const generator of generators || []) {
        const generatorKey = workflowGeneratorTreeRowKey("generator", generator.id);
        const generatorExpanded = expandedGeneratorIds.has(generator.id);
        rows.push({
            key: generatorKey,
            kind: "generator",
            workflowGeneratorId: generator.id,
            parentKey: null,
            depth: 1,
            expanded: generatorExpanded,
            hasChildren: generator.workflowRuns.length > 0,
        });
        if (!generatorExpanded) continue;

        for (const workflowRun of generator.workflowRuns) {
            const workflowRunKey = workflowGeneratorTreeRowKey("workflowRun", generator.id, workflowRun.id);
            const workflowRunExpanded = expandedWorkflowRunIds.has(workflowRun.id);
            rows.push({
                key: workflowRunKey,
                kind: "workflowRun",
                workflowGeneratorId: generator.id,
                workflowRunId: workflowRun.id,
                parentKey: generatorKey,
                depth: 2,
                expanded: workflowRunExpanded,
                hasChildren: workflowRun.transitions.length > 0,
            });
            if (!workflowRunExpanded) continue;

            for (const transition of workflowRun.transitions) {
                rows.push({
                    key: workflowGeneratorTreeRowKey(
                        "transition",
                        generator.id,
                        workflowRun.id,
                        transition.id,
                    ),
                    kind: "transition",
                    workflowGeneratorId: generator.id,
                    workflowRunId: workflowRun.id,
                    transitionId: transition.id,
                    parentKey: workflowRunKey,
                    depth: 3,
                    expanded: false,
                    hasChildren: false,
                });
            }
        }
    }
    return rows;
}

export function navigateWorkflowGeneratorTree(rows, selectedKey, key) {
    if (!rows.length) return null;
    const currentIndex = rows.findIndex((row) => row.key === selectedKey);
    if (currentIndex < 0) {
        if (key === "ArrowUp") return { type: "select", row: rows[rows.length - 1] };
        if (key === "ArrowDown" || key === "ArrowRight") {
            return { type: "select", row: rows[0] };
        }
        return null;
    }

    const current = rows[currentIndex];
    if (key === "ArrowUp") {
        return currentIndex > 0 ? { type: "select", row: rows[currentIndex - 1] } : null;
    }
    if (key === "ArrowDown") {
        return currentIndex < rows.length - 1
            ? { type: "select", row: rows[currentIndex + 1] }
            : null;
    }
    if (key === "ArrowRight") {
        // Generators and WorkflowRuns are always-expandable containers: even with zero
        // children they expand to reveal an empty-state row ("No materialized
        // workflowRuns" / "No lifecycle state runs"), matching what the mouse toggle
        // already does. Only transitions are leaves.
        const expandable = current.kind === "generator" || current.kind === "workflowRun";
        if (expandable && !current.expanded) {
            return { type: "expand", row: current };
        }
        const child = rows[currentIndex + 1];
        return child?.parentKey === current.key ? { type: "select", row: child } : null;
    }
    if (key === "ArrowLeft") {
        if (current.expanded) {
            return { type: "collapse", row: current };
        }
        const parent = rows.find((row) => row.key === current.parentKey);
        return parent ? { type: "select", row: parent } : null;
    }
    return null;
}

function optionalText(value) {
    const text = typeof value === "string" ? value.trim() : "";
    return text || null;
}

function workflowRunOwnerLabel(owner) {
    return optionalText(owner?.displayName)
        || optionalText(owner?.email)
        || optionalText(owner?.subject)
        || "Unknown owner";
}

function effectiveWorkflowRunAffinities(workflowRun) {
    const config = workflowRun?.effectiveConfig;
    if (!config || typeof config !== "object" || Array.isArray(config)) return {};
    const affinities = config.affinities;
    return affinities && typeof affinities === "object" && !Array.isArray(affinities)
        ? affinities
        : {};
}

export function workflowRunOrigin(workflowRun) {
    const origin = optionalText(workflowRun?.origin)?.toLowerCase();
    const producerType = optionalText(workflowRun?.producerType)?.toLowerCase();
    if (
        origin === "workflow generator"
        || origin === "workflow_generator"
        || origin === "generated"
        || producerType === "workflow_generator"
        || optionalText(workflowRun?.workflowGeneratorId)
    ) {
        return "Workflow Generator";
    }
    if (
        origin === "direct"
        || origin === "direct_request"
        || producerType === "direct_request"
    ) {
        return "Direct";
    }
    return "Origin unavailable";
}

export function toWorkflowRunCatalogRow(workflowRun) {
    const affinities = effectiveWorkflowRunAffinities(workflowRun);
    const workflowRunId = optionalText(workflowRun?.workflowRunId);
    const workflowRunKey = optionalText(workflowRun?.workflowRunKey);
    const workflowType = optionalText(workflowRun?.workflowType);
    return {
        id: workflowRunId || "",
        key: workflowRunKey || workflowRunId || "Unnamed Workflow Run",
        workflowType: workflowType || "Workflow",
        workflowDefinitionId: optionalText(workflowRun?.workflowDefinitionId),
        lifecycleState: optionalText(workflowRun?.lifecycleState) || "pending_session",
        currentState: optionalText(workflowRun?.currentState) || "Pending",
        stateRevision: Number.isFinite(Number(workflowRun?.stateRevision))
            ? Number(workflowRun.stateRevision)
            : 0,
        owner: workflowRun?.requestedBy || workflowRun?.owner || null,
        ownerLabel: workflowRunOwnerLabel(workflowRun?.requestedBy || workflowRun?.owner),
        origin: workflowRunOrigin(workflowRun),
        workflowGeneratorId: optionalText(workflowRun?.workflowGeneratorId),
        repository: optionalText(workflowRun?.repository)
            || optionalText(workflowRun?.scope)
            || optionalText(affinities.repo),
        compute: optionalText(workflowRun?.computePlacement)
            || optionalText(workflowRun?.sessionComputeAffinity)
            || optionalText(affinities.compute),
        createdAt: workflowRun?.createdAt || null,
        updatedAt: workflowRun?.updatedAt || null,
        raw: workflowRun,
    };
}

export function toWorkflowRunCatalog(rows) {
    return (Array.isArray(rows) ? rows : [])
        .map(toWorkflowRunCatalogRow)
        .filter((row) => row.id);
}

function workflowRunCatalogStatus(row) {
    switch (row?.lifecycleState) {
        case "active": return "RUNNING";
        case "blocked": return "PARKED";
        case "completed": return "DONE";
        case "cancelled": return "ABANDONED";
        default: return "READY";
    }
}

function workflowRunCatalogColumnValue(row, column) {
    switch (column) {
        case "status": return workflowRunCatalogStatus(row);
        case "workflow": return row?.workflowType || "";
        case "key": return row?.key || "";
        case "currentState": return row?.currentState || "";
        case "origin": return row?.origin || "";
        case "owner": return row?.ownerLabel || "";
        case "updated": return row?.updatedAt || "";
        default: return "";
    }
}

export function applyWorkflowRunCatalogView(
    rows,
    { filters = {}, sortColumn = null, sortDirection = "asc" } = {},
) {
    const normalizedFilters = Object.entries(filters)
        .map(([column, value]) => [column, String(value || "").trim().toLocaleLowerCase()])
        .filter(([, value]) => value);
    const filtered = (Array.isArray(rows) ? rows : []).filter((row) => (
        normalizedFilters.every(([column, filter]) => {
            const value = workflowRunCatalogColumnValue(row, column);
            const searchable = column === "updated" && value
                ? `${value} ${new Date(value).toLocaleString()}`
                : String(value);
            return searchable.toLocaleLowerCase().includes(filter);
        })
    ));
    if (!sortColumn) return filtered;

    const direction = sortDirection === "desc" ? -1 : 1;
    return filtered
        .map((row, index) => ({ row, index }))
        .sort((left, right) => {
            const leftValue = workflowRunCatalogColumnValue(left.row, sortColumn);
            const rightValue = workflowRunCatalogColumnValue(right.row, sortColumn);
            const comparison = sortColumn === "updated"
                ? (Date.parse(leftValue) || 0) - (Date.parse(rightValue) || 0)
                : String(leftValue).localeCompare(String(rightValue), undefined, {
                    numeric: true,
                    sensitivity: "base",
                });
            return comparison === 0 ? left.index - right.index : comparison * direction;
        })
        .map(({ row }) => row);
}
