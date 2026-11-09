import React from "react";
import { ChatCallLine } from "./chat-call-line.js";
import { chatCallLine } from "../../core/src/chat-activity.js";
import { NATIVE_TASK_LABELS, nativeTaskProfile } from "../../core/src/native-tasks.js";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const MARKS = { starting: "◷", running: "◷", waiting: "Ⅱ", completed: "✓", failed: "!", cancelled: "■", interrupted: "↯" };
function duration(task, now) {
    const ms = task.durationMs ?? (task.startedAt ? (task.completedAt || now) - task.startedAt : null);
    if (!Number.isFinite(ms) || ms < 0) return "";
    const seconds = Math.floor(ms / 1000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export const NativeTaskCard = React.memo(function NativeTaskCard({ group, colors }) {
    const [showAll, setShowAll] = React.useState(false);
    const [now, setNow] = React.useState(Date.now);
    const active = group.tasks.some(task => !TERMINAL.has(task.status));
    React.useEffect(() => {
        if (!active) return undefined;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [active]);
    const counts = group.tasks.reduce((acc, task) => {
        const label = NATIVE_TASK_LABELS[task.status] || "Unknown";
        acc[label] = (acc[label] || 0) + 1;
        return acc;
    }, {});
    const countLabel = Object.entries(counts).map(([label, count]) => `${count} ${label.toLowerCase()}`).join(" · ");
    const tasks = showAll ? group.tasks : group.tasks.slice(0, 3);
    return React.createElement("section", { className: "ps-native-tasks", "aria-label": "Native tasks", "data-task-group": group.id },
        React.createElement("header", { className: "ps-native-tasks-header" },
            React.createElement("span", { className: "ps-native-tasks-title" },
                React.createElement("span", { className: "ps-native-task-branch", "aria-hidden": true }, "⑂"), "Native tasks"),
            React.createElement("span", { className: "ps-native-tasks-count", "aria-live": "polite" }, countLabel)),
        tasks.map(task => React.createElement(NativeTask, { key: task.id, task, colors, now })),
        group.tasks.length > 3 ? React.createElement("button", { type: "button", className: "ps-native-tasks-more", "aria-expanded": showAll,
            onClick: () => setShowAll(value => !value) }, showAll ? "Show fewer tasks" : `Show ${group.tasks.length - 3} more tasks`) : null);
});

function NativeTask({ task, colors, now }) {
    const [open, setOpen] = React.useState(false);
    const viewport = React.useRef(null);
    const follow = React.useRef(true);
    const calls = React.useMemo(() => (task.calls || []).map(chatCallLine), [task.calls]);
    React.useLayoutEffect(() => {
        if (open && viewport.current && follow.current) viewport.current.scrollTop = viewport.current.scrollHeight;
    }, [open, calls]);
    const preview = task.error || task.result || task.preview || (task.status === "completed" ? "Task completed." : "");
    const time = duration(task, now);
    const profile = nativeTaskProfile(task);
    return React.createElement("details", {
        className: "ps-native-task", "data-task-id": task.id, "data-status": task.status, open,
        onToggle: event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); },
        style: { "--ps-native-task-accent": colors[task.status] || colors.running },
    },
        React.createElement("summary", null,
            React.createElement("span", { className: "ps-native-task-mark", "aria-hidden": true }, MARKS[task.status] || "?"),
            React.createElement("span", { className: "ps-native-task-main" },
                React.createElement("span", { className: "ps-native-task-title" },
                    React.createElement("span", {
                        className: profile.kind === "repo" ? "ps-native-task-profile ps-native-task-profile--repo"
                            : profile.kind === "loaded" ? "ps-native-task-profile ps-native-task-profile--loaded" : "ps-native-task-profile",
                        ...(profile.title ? { title: profile.title } : {}),
                    }, profile.label),
                    task.title === "Native task" ? "Working on delegated request" : task.title),
                preview ? React.createElement("span", { className: "ps-native-task-preview" }, preview.replace(/\s+/g, " ").slice(0, 240)) : null),
            React.createElement("span", { className: "ps-native-task-meta" },
                React.createElement("span", { className: "ps-native-task-status" }, task.telemetryStale ? "Reconnecting" : NATIVE_TASK_LABELS[task.status] || task.status),
                React.createElement("span", null, [time, `${task.toolCalls || 0} ${task.toolCalls === 1 ? "call" : "calls"}`].filter(Boolean).join(" · "))),
            React.createElement("span", { className: "ps-native-task-chevron", "aria-hidden": true }, "›")),
        React.createElement("div", { className: "ps-native-task-detail" },
            React.createElement("div", { className: "ps-native-task-scope" },
                [profile.kind === "repo" ? `${task.profile} agent from ${profile.repo}`
                    : profile.kind === "loaded" ? `${task.profile} agent from ${profile.from}` : null,
                task.model, task.reasoningEffort, "Same worker"].filter(Boolean).join(" · ")),
            calls.length ? React.createElement("div", {
                ref: viewport, className: "ps-native-task-calls", role: "region", "aria-label": `Tool calls for ${task.title}`, tabIndex: 0,
                onScroll: event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 24; },
                onWheel: event => { if (event.deltaY < 0) follow.current = false; },
                onTouchStart: () => { follow.current = false; },
            }, calls.map(line => React.createElement(ChatCallLine, { key: line.callKey, line }))) :
                React.createElement("p", { className: "ps-native-task-scope" }, task.toolCalls ? "Tool details are not available in this recording." : "Waiting for task activity…"),
            task.result || task.error ? React.createElement("p", { className: "ps-native-task-result" }, task.error || task.result) : null,
            task.recentActivity?.length && !task.calls?.length ? React.createElement("ul", { className: "ps-native-task-activity" },
                task.recentActivity.map((activity, i) => React.createElement("li", { key: i }, activity.message))) : null));
}
