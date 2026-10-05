const columns = [
    { key: "file", label: "Test file", type: "string" },
    { key: "status", label: "Result", type: "string" },
    { key: "durationMs", label: "Duration", type: "number" },
    { key: "attempts", label: "Attempts", type: "number" },
    { key: "passed", label: "Passed", type: "number" },
    { key: "failed", label: "Failed", type: "number" },
    { key: "timedOut", label: "Timed out", type: "number" },
    { key: "interrupted", label: "Interrupted", type: "number" },
    { key: "stability", label: "Stability", type: "string" },
    { key: "lastRunAt", label: "Last run", type: "date" },
    { key: "notes", label: "Notes", type: "string" },
];

const elements = {
    metadata: document.getElementById("metadata"),
    cards: document.getElementById("cards"),
    error: document.getElementById("error"),
    search: document.getElementById("search"),
    result: document.getElementById("result-filter"),
    stability: document.getElementById("stability-filter"),
    minDuration: document.getElementById("min-duration"),
    maxDuration: document.getElementById("max-duration"),
    minAttempts: document.getElementById("min-attempts"),
    visibleCount: document.getElementById("visible-count"),
    totalCount: document.getElementById("total-count"),
    refreshedAt: document.getElementById("refreshed-at"),
    autoRefresh: document.getElementById("auto-refresh"),
    table: document.getElementById("results-table"),
    liveStatus: document.getElementById("live-status"),
    liveCards: document.getElementById("live-cards"),
    activeFiles: document.getElementById("active-files"),
};

let rows = [];
let sort = { key: "file", direction: "ascending" };

function historyCounts(entry) {
    const counts = { passed: 0, failed: 0, timed_out: 0, interrupted: 0 };
    for (const attempt of entry.attempts ?? []) {
        if (attempt.status in counts) counts[attempt.status]++;
    }
    return counts;
}

function stability(entry, counts) {
    if ([counts.passed, counts.failed, counts.timed_out].filter((count) => count > 0).length > 1) {
        return "Mixed";
    }
    if ((entry.attempts?.length ?? 0) < 2) return "Single observation";
    return "Consistent";
}

function formatDuration(durationMs) {
    if (durationMs == null) return "—";
    if (durationMs < 1000) return `${durationMs}ms`;
    const seconds = Math.round(durationMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function normalize(data) {
    return Object.entries(data.tests ?? {}).map(([file, entry]) => {
        const counts = historyCounts(entry);
        return {
            file,
            status: entry.status ?? "pending",
            durationMs: entry.latestDurationMs,
            durationText: formatDuration(entry.latestDurationMs),
            attempts: entry.attempts?.length ?? 0,
            ...counts,
            timedOut: counts.timed_out,
            stability: stability(entry, counts),
            lastRunAt: entry.lastRunAt ?? "",
            notes: entry.notes ?? "",
            search: `${file} ${entry.notes ?? ""}`.toLowerCase(),
        };
    });
}

function createCell(value, className) {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    cell.textContent = value;
    return cell;
}

function renderHeader() {
    const header = document.getElementById("header-row");
    header.replaceChildren();
    for (const column of columns) {
        const th = document.createElement("th");
        th.setAttribute("aria-sort", sort.key === column.key ? sort.direction : "none");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = column.label;
        button.addEventListener("click", () => {
            sort = {
                key: column.key,
                direction: sort.key === column.key && sort.direction === "ascending"
                    ? "descending"
                    : "ascending",
            };
            render();
        });
        th.append(button);
        header.append(th);
    }
}

function selectedResults() {
    return new Set([...elements.result.selectedOptions].map((option) => option.value));
}

function filteredRows() {
    const query = elements.search.value.trim().toLowerCase();
    const results = selectedResults();
    const selectedStability = elements.stability.value;
    const minDuration = elements.minDuration.value === "" ? null : Number(elements.minDuration.value) * 1000;
    const maxDuration = elements.maxDuration.value === "" ? null : Number(elements.maxDuration.value) * 1000;
    const minAttempts = elements.minAttempts.value === "" ? null : Number(elements.minAttempts.value);
    return rows.filter((row) => {
        const durationKnown = row.durationMs != null;
        return (!query || row.search.includes(query))
            && (results.size === 0 || results.has(row.status))
            && (!selectedStability || row.stability === selectedStability)
            && (minDuration === null || (durationKnown && row.durationMs >= minDuration))
            && (maxDuration === null || (durationKnown && row.durationMs <= maxDuration))
            && (minAttempts === null || row.attempts >= minAttempts);
    });
}

function compare(left, right) {
    const column = columns.find((candidate) => candidate.key === sort.key);
    let a = left[sort.key];
    let b = right[sort.key];
    if (column.type === "date") {
        a = a ? Date.parse(a) || 0 : 0;
        b = b ? Date.parse(b) || 0 : 0;
    } else if (column.type === "number") {
        a = a ?? -1;
        b = b ?? -1;
    } else {
        a = String(a ?? "").toLowerCase();
        b = String(b ?? "").toLowerCase();
    }
    const result = a < b ? -1 : a > b ? 1 : 0;
    return sort.direction === "ascending" ? result : -result;
}

function renderRows() {
    const visible = filteredRows().sort(compare);
    const body = elements.table.tBodies[0];
    body.replaceChildren();
    for (const row of visible) {
        const tr = document.createElement("tr");
        const file = createCell("");
        const code = document.createElement("code");
        code.textContent = row.file;
        file.append(code);
        tr.append(file);

        const result = createCell("");
        const status = document.createElement("span");
        status.className = `status status-${row.status}`;
        status.textContent = (row.status[0].toUpperCase() + row.status.slice(1))
            .replaceAll("_", " ");
        result.append(status);
        tr.append(result);

        tr.append(createCell(row.durationText, "number"));
        tr.append(createCell(String(row.attempts), "number"));
        tr.append(createCell(String(row.passed), "number"));
        tr.append(createCell(String(row.failed), "number"));
        tr.append(createCell(String(row.timedOut), "number"));
        tr.append(createCell(String(row.interrupted), "number"));
        tr.append(createCell(row.stability));
        tr.append(createCell(row.lastRunAt ? row.lastRunAt.slice(0, 10) : "—"));
        const notes = createCell(row.notes || "—");
        notes.title = row.notes;
        tr.append(notes);
        body.append(tr);
    }
    elements.visibleCount.textContent = String(visible.length);
    elements.totalCount.textContent = String(rows.length);
}

function renderCards(summary) {
    const cards = [
        ["Total files", summary.total],
        ["Passed", summary.passed],
        ["Failed", summary.failed],
        ["Timed out", summary.timed_out],
        ["Interrupted", summary.interrupted],
        ["Pending", summary.pending],
        ["Mixed history", summary.mixed ?? summary.flaky],
        ["Total attempts", summary.attempts],
    ];
    elements.cards.replaceChildren(...cards.map(([label, value]) => {
        const card = document.createElement("div");
        card.className = "card";
        const strong = document.createElement("strong");
        strong.textContent = String(value ?? 0);
        const span = document.createElement("span");
        span.textContent = label;
        card.append(strong, span);
        return card;
    }));
}

function formatAge(milliseconds) {
    if (milliseconds == null) return "unknown";
    return `${formatDuration(milliseconds)} ago`;
}

function currentRound(data) {
    const run = data.currentRun;
    return run?.rounds?.find((round) => round.number === run.round) ?? null;
}

function renderLive(data) {
    const run = data.currentRun;
    const round = currentRound(data);
    const now = Date.now();
    const heartbeatAge = run?.heartbeatAt ? Math.max(0, now - Date.parse(run.heartbeatAt)) : null;
    const progressAge = run?.lastProgressAt ? Math.max(0, now - Date.parse(run.lastProgressAt)) : null;
    const transitionAge = run?.lastTransitionAt
        ? Math.max(0, now - Date.parse(run.lastTransitionAt))
        : null;
    elements.liveStatus.textContent = [
        `campaign ${data.status ?? "unknown"}`,
        run?.phase ? `${run.phase} round ${run.round ?? "—"}` : "no run",
        data.terminalReason ?? run?.terminalReason,
    ].filter(Boolean).join(" · ");
    if (run?.status === "running" && heartbeatAge > 15_000) {
        elements.liveStatus.classList.add("warning");
    } else {
        elements.liveStatus.classList.remove("warning");
    }
    const cards = [
        ["Round progress", round ? `${round.completed}/${round.total}` : "—"],
        ["Unfinished jobs", round?.remaining ?? 0],
        ["Queued / active", round ? `${round.queued} / ${round.active}` : "—"],
        ["Campaign unfinished", data.summary?.unfinished ?? 0],
        ["Last progress", formatAge(progressAge)],
        ["Last transition", formatAge(transitionAge)],
        ["Heartbeat", formatAge(heartbeatAge)],
    ];
    elements.liveCards.replaceChildren(...cards.map(([label, value]) => {
        const card = document.createElement("div");
        card.className = "card";
        const strong = document.createElement("strong");
        strong.textContent = String(value);
        const span = document.createElement("span");
        span.textContent = label;
        card.append(strong, span);
        return card;
    }));
    const active = Object.entries(run?.activeFiles ?? {});
    elements.activeFiles.replaceChildren();
    if (active.length === 0) {
        elements.activeFiles.textContent = "No active files.";
        return;
    }
    for (const [file, entry] of active) {
        const row = document.createElement("div");
        row.className = "active-file";
        const elapsed = Math.max(0, now - Date.parse(entry.startedAt));
        const deadline = Math.max(0, Date.parse(entry.deadlineAt) - now);
        row.textContent = `slot ${entry.slot} · ${file} · elapsed ${formatDuration(elapsed)}`
            + ` · deadline in ${formatDuration(deadline)}`;
        elements.activeFiles.append(row);
    }
}

function render() {
    renderHeader();
    renderRows();
}

async function refresh() {
    try {
        const response = await fetch("/api/results", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        rows = normalize(data);
        const testedRevision = data.repository ?? {};
        elements.metadata.textContent = [
            testedRevision.repository ?? "unknown repository",
            `${testedRevision.branch ?? "unknown"} @ `
                + `${testedRevision.commitId ?? "unknown"}`,
            `updated ${data.updatedAt ?? "unknown"}`,
        ].join(" · ");
        renderCards(data.summary ?? {});
        renderLive(data);
        render();
        elements.error.hidden = true;
        elements.refreshedAt.textContent = new Date().toLocaleTimeString();
    } catch (error) {
        elements.error.textContent = error.message;
        elements.error.hidden = false;
    }
}

for (const element of [
    elements.search,
    elements.result,
    elements.stability,
    elements.minDuration,
    elements.maxDuration,
    elements.minAttempts,
]) {
    element.addEventListener("input", renderRows);
    element.addEventListener("change", renderRows);
}
document.getElementById("clear-filters").addEventListener("click", () => {
    elements.search.value = "";
    for (const option of elements.result.options) option.selected = false;
    elements.stability.value = "";
    elements.minDuration.value = "";
    elements.maxDuration.value = "";
    elements.minAttempts.value = "";
    renderRows();
});
document.getElementById("refresh").addEventListener("click", refresh);
setInterval(() => {
    if (elements.autoRefresh.checked) void refresh();
}, 3000);
void refresh();
