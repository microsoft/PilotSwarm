import React from "react";
import { useControllerSelector } from "./use-controller-state.js";
import {
    workflowParentWorking, projectWorkflow,
} from "../../core/src/workflow-view.js";
import { workflowDraftMarks, workflowRunInputs } from "../../core/src/workflow-commands.js";
import {
    workflowChildModel, workflowElapsedText, workflowFailure, workflowRunTimes, workflowStateOf, workflowTabButtonTip,
    WORKFLOW_DEFINITION_PANELS, workflowPanelIsSide,
} from "../../core/src/workflow-owner.js";
import {
    chatDefinitionDefault, chatDefinitionOfWorkflow, chatDefinitionOptionLabel, chatLatestWorkflow, chatDefinitionReadKey, chatNextWorkflowNumber, chatReadAccess,
    chatCopiedFromWords, chatDefinitionChangeControls, chatDefinitionChoice, chatDeleteWords, chatEditorAfterSave, chatLastTestWords, chatPackageDefinitionWords, chatRevisionCompare, chatRevisionOptionLabel, chatRevisionReadModel, chatShownRevision, chatStartControl,
    chatRevisionFace, chatRevisionInfoWords,
} from "../../core/src/workflow-chat-definitions.js";
import { CompareView, WorkflowDiagnostics, WorkflowNoGraph, WorkflowYamlBox } from "./workflow-panels.js";
import { WorkflowGraph } from "./workflow-graph.js";
import { workflowLifecycleAtOf } from "../../core/src/workflow-lifecycle.js";
import { WorkflowToolButton } from "./workflow-tool-button.js";
import { PHONE_MEDIA_QUERY, useMediaQuery } from "./use-media-query.js";
import { WORKFLOW_RUN_STATE_WORDS, workflowModelFromKey, workflowRefusalText, workflowSessionModelKey, workflowStartModels } from "../../core/src/workflow-words.js";
import {
    BottomPanel, Dialog, FacedPicker, LIST_READ_LIMIT, NodeFacts, StartDialog, StateChip, WorkflowRunView, WorkflowStage, revisionLine, shownTime, shownTimeTitle,
    workflowGraphMode,
} from "./workflow-tab.js";

const h = React.createElement;
const EMPTY = Object.freeze({});
const EMPTY_EVENTS = Object.freeze([]);

/**
 * Review 21:15Z: a refused save, copy, update or delete begins with what was not done ("Revision not saved: …", "Copy
 * refused: …"). An answer that never came says so in its own words: it may have happened, so it is not called refused.
 */
const chatRefusal = (label, result, fallback) => (result?.phase === "unconfirmed" && result?.message
    ? result.message : workflowRefusalText(label, result?.message, fallback));

/**
 * Workflow Simplified stage 2.1b: the Workflow tab on a chat's own Workflow Definitions (spec "definitions" R1, R4–R6;
 * "editing" E2-1..E2-8; the coordinator's 2.1 readings Q1–Q10). A definition belongs to the chat and has revisions 1, 2,
 * 3; each Workflow runs the revision it started with (R1). The header picks a definition (one option each; the stage 1
 * version picker is gone: revisions, not versions, order the history); the Definition view picks a revision and shows its
 * graph, its YAML (editable, with Save, for the chat's owner or an admin when the deployment takes a person's commands),
 * Compare (any two revisions) and Start…; Delete… asks first. The Workflows view lists its Workflows, each with the revision
 * it runs, and a Workflow's own view adds Run again… (the same revision). Every save, start and delete is the server's
 * decision, in its words. Stage 2.3 (E2-7, P5, P6): a package's definition says "From <package> <version> · locked", its
 * YAML is read-only, Make a copy makes an editable one, and a newer package version is offered for the next Workflow.
 */
export function ChatWorkflowTab({ controller, mobile = false, modeButtons = null, displayMode = "normal", context, definitions, listError = null }) {
    const phone = useMediaQuery(PHONE_MEDIA_QUERY) && mobile;
    const ownerId = context.ownerId;
    const shownId = context.workflowId;
    // F4 (stage 1): this tab records what it showed; the Workflow button's dot clears. OF-S2-4 (C): every lifecycle change counts.
    const attentionAt = useControllerSelector(controller, state => workflowLifecycleAtOf(state, ownerId));
    React.useEffect(() => {
        // OF-S2-4d: shown once is a receipt even before any lifecycle change (1 ms: older than every change).
        if (ownerId) controller.dispatch({ type: "canvas/viewed", sessionId: ownerId, workflowAt: Math.max(attentionAt, 1) });
    }, [controller, ownerId, attentionAt]);
    const byId = useControllerSelector(controller, state => state.sessions.byId);
    const views = useControllerSelector(controller, state => state.ui.workflowViews);
    const tabs = useControllerSelector(controller, state => state.ui.workflowTabs);
    const key = ownerId ?? shownId;
    const tab = (key && tabs?.[key]) || EMPTY;
    const setTab = React.useCallback(patch => {
        if (key) controller.dispatch({ type: "ui/workflowTab", ownerId: key, patch });
    }, [controller, key]);
    const found = chatDefinitionOfWorkflow(definitions, shownId);
    // A Workflow shown is its definition's; else the definition chosen here; else the one saved most recently.
    const definition = found?.definition ?? definitions.find(item => item.definitionId === tab.chatDefinitionId) ?? chatDefinitionDefault(definitions);
    const workflow = found?.workflow ?? null;
    const view = tab.view === "definition" || tab.view === "workflows" ? tab.view : workflow ? "workflows" : "definition";
    // The Definition view shows the revision chosen ("newest" follows the newest); with none chosen, the revision of the
    // Workflow shown (stage 1 UI4-F2: the view describes the Workflow selected), else the newest.
    const revision = definition ? chatShownRevision(definition, tab.chatRevision === "newest" ? definition.currentRevision
        : Number.isSafeInteger(tab.chatRevision) ? tab.chatRevision : found?.workflow?.revision ?? found?.draft?.revision ?? null) : null;
    // OF-S2-8: the revision shown, as read, for the header's Start… (the Definition view reads it).
    const shownRead = useControllerSelector(controller, state => (ownerId && definition && view === "definition" && Number.isSafeInteger(revision)
        ? state.ui.chatDefinitionReads?.[ownerId]?.[chatDefinitionReadKey(definition.definitionId, revision)] ?? null : null));
    const openWorkflow = React.useCallback(id => {
        setTab({ view: "workflows", workflowId: id ?? null, chatRevision: null });
        // Opening one selects its row (W2); one whose row is not loaded yet (just started) is shown once it is.
        const target = id && byId?.[id] ? id : ownerId;
        if (target) controller.dispatch({ type: "sessions/selected", sessionId: target });
    }, [controller, setTab, ownerId, byId]);
    // Review S2UI-F3: the picker's choice and Make a copy's new definition take the same move (chatDefinitionChoice).
    const chooseDefinition = React.useCallback((definitionId, view = null) => {
        const choice = chatDefinitionChoice(definitionId, { workflowShown: Boolean(shownId), view });
        setTab(choice.patch);
        if (choice.selectOwner && ownerId) controller.dispatch({ type: "sessions/selected", sessionId: ownerId });
    }, [controller, setTab, shownId, ownerId]);
    const shownState = workflow ? workflowStateOf(byId?.[workflow.sessionId], views?.[workflow.sessionId] ?? null) : null;
    React.useEffect(() => {
        if (workflow && view === "workflows" && shownState?.key === "failed") controller.dispatch({ type: "ui/workflowSeen", sessionId: workflow.sessionId });
    }, [controller, workflow?.sessionId, view, shownState?.key]);
    const listLine = listError ? h("p", { className: "ps-wf-line is-error", role: "alert", "data-chat-definitions": "error" },
        `The definitions could not be read again: ${listError} `,
        h("button", { type: "button", className: "ps-mini-button", onClick: () => controller.ensureChatWorkflowDefinitions(ownerId, { force: true }) }, "Retry"))
        : null;
    if (!definition) {
        return h("section", { className: "ps-wf-tab is-empty", "aria-label": "Workflow", "data-chat-definitions": "true" },
            modeButtons ? h("header", { className: "ps-wf-tab-head" }, h("span", { className: "ps-wf-tab-modes" }, modeButtons)) : null,
            listLine,
            h("div", { className: "ps-wf-empty" },
                h("p", { className: "ps-wf-empty-title" }, "No definitions yet."),
                h("p", null, "Ask the chat to create one.")));
    }
    const ownerSession = ownerId ? byId?.[ownerId] ?? null : null;
    // UX2R-F1: the tab opened on the Definition view by itself (no view chosen, no Workflow shown) after a Workflow ran: its
    // newest Workflow and its state, one click away.
    const latest = view === "definition" && !tab.view && !workflow ? chatLatestWorkflow(definition, byId, views) : null;
    // OF-S2-8 (owner, 2026-11-07T23:18Z, confirmed 23:19Z): one row: "Definition" and its picker, then in the Definition view
    // "Rev" and its picker, the Definition | Workflows icons, the Definition view's YAML and Compare, and Start… at its end;
    // full screen at the right. A phone wraps it to two lines rather than shrink the pickers: Definition (with full screen),
    // then Rev, the icons and Start…. Who saved the revision, when, and the rest are on the dimmed line under it. The row is
    // the tab's, the same element in both views, so a picker or an icon keeps the focus when the view changes.
    const onDefinition = view === "definition";
    const start = onDefinition ? startControlOf(definition, revision, shownRead) : null;
    const yaml = tab.chatYaml === true;
    const compare = tab.definitionPanel === "revisions";
    const modes = modeButtons ? h("span", { className: "ps-wf-tab-modes" }, modeButtons) : null;
    const wraps = phone && onDefinition;
    const rest = h("span", { className: "ps-wf-head-rest" },
        onDefinition ? h(ChatRevisionPicker, { definition, revision,
            onChoose: number => setTab({ chatRevision: number === definition.currentRevision ? "newest" : number }) }) : null,
        h("div", { className: "ps-wf-switch is-icons", role: "group", "aria-label": "Definition or Workflows" },
            // UX2P-F3: the header's tooltips show above their buttons, so they never cover the lines under them.
            h(WorkflowToolButton, { label: "Definition", glyph: "definition", title: workflowTabButtonTip("definition"), tipAbove: true,
                "aria-pressed": view === "definition", onClick: () => setTab({ view: "definition" }) }),
            h(WorkflowToolButton, { label: "Workflows", glyph: "workflows", title: workflowTabButtonTip("workflows"), tipAbove: true,
                "aria-pressed": view === "workflows", onClick: () => setTab({ view: "workflows" }) })),
        onDefinition ? h("span", { className: "ps-wf-head-actions" },
            h(WorkflowToolButton, { label: "YAML", glyph: "yaml", title: workflowTabButtonTip("yaml"), "aria-pressed": yaml, tipAbove: true,
                onClick: () => setTab({ chatYaml: !yaml }) }),
            h(WorkflowToolButton, { label: "Compare", glyph: "compare", title: "compare any two revisions side by side", "aria-pressed": compare,
                tipAbove: true, onClick: () => setTab({ definitionPanel: compare ? null : "revisions" }) }),
            // Start… asks the Definition view to open the Start form (as Start… in the Workflows view does).
            h(WorkflowToolButton, { label: "Start…", glyph: "start", "data-action": "start", disabled: !start.enabled, tipAbove: true,
                title: start.enabled ? `start Workflow #${chatNextWorkflowNumber(definition)} from revision ${revision}` : start.title,
                onClick: () => setTab({ chatStart: true }) })) : null);
    return h("section", { className: `ps-wf-tab${mobile ? " is-mobile" : ""}${phone ? " is-phone" : ""}`, "aria-label": "Workflow", "data-view": view,
        "data-definition": definition.name, "data-definition-id": definition.definitionId, "data-revision": revision ?? undefined,
        "data-chat-definitions": "true" },
        h("header", { className: `ps-wf-tab-head is-pickers${wraps ? " is-two-lines" : ""}` },
            h(ChatDefinitionPicker, { definitions, chosen: definition, onChoose: chooseDefinition }),
            wraps ? modes : null,
            rest,
            wraps ? null : modes),
        listLine,
        latest ? h("p", { className: "ps-wf-line ps-wf-latest", role: "status", "data-field": "latest-workflow" }, `${latest.text} · `,
            h("button", { type: "button", className: "ps-link-button", "data-action": "view-latest", "aria-label": `View Workflow #${latest.number}`,
                onClick: () => openWorkflow(latest.sessionId) }, "View it")) : null,
        view === "definition"
            ? h(ChatDefinitionView, { key: definition.definitionId, controller, ownerId, definition, revision, tab, setTab, mobile, phone, displayMode,
                ownerTitle: ownerSession?.title ?? null, ownerWorking: ownerSession ? workflowParentWorking(ownerSession) : false,
                onStarted: openWorkflow, onDeleted: () => setTab({ chatDefinitionId: null, chatRevision: null, definitionPanel: null }),
                onChooseDefinition: chooseDefinition })
            : workflow
                ? h(ChatRunView, { key: workflow.sessionId, controller, ownerId, definition, workflow, tab, setTab, mobile, phone, displayMode,
                    onOpen: openWorkflow, nodeStateId: context.nodeStateId })
                : h(ChatWorkflowList, { controller, definition, byId, views, onOpen: openWorkflow,
                    onStart: () => setTab({ view: "definition", chatRevision: definition.newestValidRevision ?? null, chatStart: true }),
                    onShowRevision: number => setTab({ view: "definition", chatRevision: number }) }));
}

/**
 * The chat's definitions, one option each (by name; a package's says "locked", a deleted one that still has Workflows
 * says so). OF-S2-8 (owner, 2026-11-07T23:15Z, 23:18Z): labelled "Definition"; closed, it shows the name alone; no "ask
 * the chat" option (the empty tab says to ask the chat).
 */
function ChatDefinitionPicker({ definitions, chosen, onChoose }) {
    const id = `wf-chat-def-${React.useId().replace(/:/g, "")}`;
    return h(FacedPicker, { id, label: "Definition", kind: "is-definition", group: "is-definition", face: chosen.name, faceTitle: chatDefinitionOptionLabel(chosen),
        value: chosen.definitionId, onChange: event => onChoose(event.target.value) },
        definitions.map(item => h("option", { key: item.definitionId, value: item.definitionId }, chatDefinitionOptionLabel(item))));
}

/** One revision of a definition as read (useChatRevisionRead): asks for it when it is not read, and once more after a failure on Retry. */
function useChatRevisionRead(controller, ownerId, definitionId, revision, role = "main") {
    const key = Number.isSafeInteger(revision) ? chatDefinitionReadKey(definitionId, revision) : null;
    const read = useControllerSelector(controller, state => (key ? state.ui.chatDefinitionReads?.[ownerId]?.[key] ?? null : null));
    // Review S2UI-F2: the read on screen is kept in the cache, and read again should it go anyway.
    React.useEffect(() => {
        if (ownerId) controller.dispatch({ type: "ui/chatDefinitionShown", ownerId, role, key });
        return () => { if (ownerId) controller.dispatch({ type: "ui/chatDefinitionShown", ownerId, role, key: null }); };
    }, [controller, ownerId, role, key]);
    const missing = !read;
    React.useEffect(() => {
        if (key && missing) controller.readChatWorkflowRevision?.(ownerId, definitionId, revision)?.catch?.(() => {});
    }, [controller, ownerId, key, missing]);
    const retry = React.useCallback(() => controller.readChatWorkflowRevision?.(ownerId, definitionId, revision, { force: true })?.catch?.(() => {}),
        [controller, ownerId, definitionId, revision]);
    return { read, retry };
}

/** Start for the revision shown, once its read says who may: { enabled, revision, title }. */
function startControlOf(definition, revision, read) {
    if (!Number.isSafeInteger(revision)) return { enabled: false, revision: null, title: "Nothing to start yet." };
    if (read?.phase !== "ready") return { enabled: false, revision, title: `Reading revision ${revision}…` };
    const control = chatStartControl(definition, revision, chatReadAccess(read.value));
    const other = definition.newestValidRevision;
    if (!control.enabled && Number.isSafeInteger(other) && other !== revision && /has errors/.test(control.title ?? "")) {
        return { ...control, title: `${control.title} Revision ${other} can: choose it in the revision list.` };
    }
    return control;
}

/** The Definition view of a chat's definition: the revision picker, its graph or YAML, Compare, Start… and Delete…. */
function ChatDefinitionView({ controller, ownerId, definition, revision, tab, setTab, mobile, phone = false, displayMode = "normal", ownerTitle = null, ownerWorking = false,
    onStarted, onDeleted, onChooseDefinition = null }) {
    const { read, retry } = useChatRevisionRead(controller, ownerId, definition.definitionId, revision);
    const value = read?.value ?? null;
    const model = React.useMemo(() => chatRevisionReadModel(definition, value), [definition.definitionId, definition.name, value]);
    const projection = React.useMemo(() => (model
        ? projectWorkflow({ definition: null, readModel: null, workflowModel: model, selectedRunId: null, events: EMPTY_EVENTS }) : null), [model]);
    const graph = projection?.definition ?? null;
    const nodes = projection?.nodes ?? [];
    const [selectedId, setSelectedId] = React.useState(null);
    const [graphView, setGraphView] = React.useState(null);
    const selected = nodes.find(node => node.id === selectedId) || nodes.find(node => node.id === graph?.initial) || nodes[0] || null;
    const placesKey = `chat:${definition.definitionId}`;
    const places = useControllerSelector(controller, state => state.ui?.workflowLayouts?.[placesKey]?.steps ?? null);
    const onPlaces = React.useCallback(steps => controller.dispatch({ type: "ui/workflowLayout", key: placesKey, steps, at: Date.now() }),
        [controller, placesKey]);
    const access = chatReadAccess(value);
    // Who may change the chat's definitions is the chat's, not a revision's: the last read that said so stands while
    // another revision is read (the editor stays open through a save and its refusal).
    const knownAccess = React.useRef(null);
    if (read?.phase === "ready") knownAccess.current = access;
    const changeAccess = read?.phase === "ready" ? access : knownAccess.current;
    const start = startControlOf(definition, revision, read);
    const mode = tab.chatYaml === true ? "yaml" : "graph";
    const [starting, setStarting] = React.useState(false);
    const chatModelKey = useControllerSelector(controller, state => workflowSessionModelKey(state.sessions.byId, ownerId));
    const chatModel = React.useMemo(() => workflowModelFromKey(chatModelKey), [chatModelKey]);
    const [deleting, setDeleting] = React.useState(false);
    // Start… from the Workflows view opens the Start form here once the revision is read.
    React.useEffect(() => {
        if (!tab.chatStart || (read?.phase !== "ready" && read?.phase !== "failed")) return;
        setTab({ chatStart: false });
        if (start.enabled) setStarting(true);
    }, [tab.chatStart, read?.phase, start.enabled]);
    const panels = WORKFLOW_DEFINITION_PANELS;
    const panel = panels.includes(tab.definitionPanel) ? tab.definitionPanel : null;
    // OF-S2-1: full screen and zen on a desktop put the panel beside the graph.
    const side = workflowPanelIsSide(displayMode, mobile);
    const select = id => {
        setSelectedId(id);
        if (!mobile || id === selectedId) setTab({ definitionPanel: "node" });
    };
    const line = revisionLine(model, { writing: ownerWorking && revision === definition.currentRevision, writer: ownerTitle });
    const nextNumber = chatNextWorkflowNumber(definition);
    // CO-1: the change controls follow the last read that said who may change the chat's definitions (changeAccess).
    const { commands, mayChange, deleteEnabled, deleteTitle } = chatDefinitionChangeControls(definition, changeAccess);
    const shownRevision = definition.revisions.find(item => item.revision === revision) ?? null;
    const lastTest = chatLastTestWords(shownRevision);
    // Stage 2.3: a package's locked definition (E2-7, P5, P6).
    const packageWords = chatPackageDefinitionWords(definition, revision);
    const copiedWords = chatCopiedFromWords(definition);
    const [packageBusy, setPackageBusy] = React.useState(null);
    const [packageNotice, setPackageNotice] = React.useState(null);
    const copy = async () => {
        setPackageBusy("copy");
        setPackageNotice(null);
        const result = await controller.copyChatWorkflowDefinition(ownerId, { definitionId: definition.definitionId, revision });
        setPackageBusy(null);
        if (result?.ok && result.receipt?.definitionId) {
            // S2UI-F3: as the picker chooses it, so a selected or remembered Workflow does not keep the locked one on screen.
            if (onChooseDefinition) onChooseDefinition(result.receipt.definitionId, "definition");
            else setTab(chatDefinitionChoice(result.receipt.definitionId, { view: "definition" }).patch);
        } else setPackageNotice(chatRefusal("Copy refused", result, "no copy was made."));
    };
    const useNewer = async () => {
        setPackageBusy("update");
        setPackageNotice(null);
        const result = await controller.updateChatWorkflowPackage(ownerId, { definitionId: definition.definitionId });
        setPackageBusy(null);
        if (result?.ok) setTab({ chatRevision: "newest" });
        else setPackageNotice(chatRefusal("Update refused", result, "the newer version was not taken."));
    };
    return h("div", { className: "ps-wf-body", "data-chat-revision": revision ?? undefined },
        // OF-S2-8 (owner, 2026-11-07T23:18Z): the dimmed line under the pickers: who saved the revision shown, when, its version,
        // newest, not valid, a package's "from <package> <version> · locked" and Make a copy; its last test; Delete… at its end.
        h(ChatRevisionInfo, { definition, revision, lastTest: lastTest ? { words: lastTest, verdict: shownRevision.lastTest.verdict } : null,
            locked: Boolean(packageWords), update: packageWords?.update ?? null, mayChange, packageBusy, onCopy: copy, onUseNewer: useNewer,
            remove: commands ? h(WorkflowToolButton, { label: "Delete…", glyph: "delete", "data-action": "delete", disabled: !deleteEnabled, title: deleteTitle,
                onClick: () => setDeleting(true) }) : null }),
        packageNotice ? h("p", { className: "ps-wf-line is-error", role: "alert", "data-field": "package-notice" }, packageNotice) : null,
        // Formal L1: a copy says what it was copied from.
        copiedWords ? h("p", { className: "ps-wf-line is-quiet", role: "status", "data-field": "copied-from" }, copiedWords) : null,
        definition.deleted ? h("p", { className: "ps-wf-line is-quiet", role: "status", "data-chat-definition": "deleted" },
            `${definition.name} was deleted${definition.deletedAt ? ` ${shownTime(definition.deletedAt)}` : ""}. Its finished Workflows keep their copies.`) : null,
        read?.phase === "failed" ? h("p", { className: "ps-wf-line is-error", role: "alert" }, `Revision ${revision} could not be read: ${read.error ?? "no reason given"} `,
            h("button", { type: "button", className: "ps-mini-button", onClick: retry }, "Retry")) : null,
        line ? h("p", { className: `ps-wf-line ${line.calm ? "is-quiet" : "is-error"}`, role: "status", "data-drafting": line.calm ? "true" : undefined }, line.text) : null,
        h(WorkflowStage, { side, panel: h(BottomPanel, { controller, panels, panel, mobile, side, onPanel: id => setTab({ definitionPanel: id }) },
            // OF-S2-8: the node's script and samples come from the revision's YAML, for those who may read it.
            panel === "node" ? h(NodeFacts, { node: selected, yaml: read?.phase === "ready" ? access.yaml : null, pending: read?.phase !== "ready" && read?.phase !== "failed",
                hidden: read?.phase === "failed" ? `The script could not be read: ${read.error ?? "no reason given"}`
                    : "Only this chat's owner or an admin can read the script." })
                : panel === "revisions" ? h(ChatCompare, { key: definition.definitionId, controller, ownerId, definition, shown: revision })
                : null) },
        h("div", { className: "ps-wf-main", hidden: mode !== "graph" || undefined },
            graph ? h(WorkflowGraph, { definition: graph, nodes, selected, select, scope: placesKey, viewport: graphView, onViewport: setGraphView,
                places, onPlaces, mobile, mode: workflowGraphMode(displayMode, side, Boolean(panel)) })
                : projection && line ? h("div", { className: "ps-wf-errors" }, h(WorkflowDiagnostics, { diagnostics: projection.diagnostics }))
                : projection ? h(WorkflowNoGraph, { projection })
                : h("p", { className: "ps-wf-muted" }, Number.isSafeInteger(revision) ? `Reading revision ${revision}…` : "No revisions yet.")),
        mode === "yaml" ? h("div", { className: "ps-wf-main ps-wf-yaml" },
            h(ChatYamlPanel, { controller, ownerId, definition, revision, read, access, changeAccess, tab, setTab, retry })) : null),
        starting ? h(StartDialog, { controller, sessionId: definition.definitionId, name: definition.name, number: nextNumber,
            publication: { inputsSchema: model?.graph?.inputsSchema ?? null, revision, publishedRevision: revision, state: "published", valid: true },
            // OF-S2-7: what each agent node will use (a person's start: the chat's model).
            models: workflowStartModels(model?.graph?.states, { chat: chatModel }),
            control: { operation: "start", enabled: true },
            startWith: ({ inputs, vars }) => controller.startChatWorkflowDefinition(ownerId, { definitionId: definition.definitionId, revision, inputs, vars }),
            onClose: () => setStarting(false),
            onStarted: result => { setStarting(false); onStarted(result?.receipt?.workflowId ?? null); } }) : null,
        deleting ? h(ChatDeleteDialog, { controller, ownerId, definition, onClose: () => setDeleting(false), onDeleted: () => { setDeleting(false); onDeleted(); } })
            : null);
}

/**
 * The revisions of a definition, newest first. OF-S2-8 (owner, 2026-11-07T23:18Z): labelled "Rev" (its name read aloud is
 * "Revision"); closed, it shows the number alone ("6"); its open list keeps each revision's detail: "Revision 6 · newest ·
 * by the chat · 09:41 · not valid · version 1.2.0". The line under the row says the shown one's detail.
 */
function ChatRevisionPicker({ definition, revision, onChoose }) {
    const id = `wf-chat-rev-${React.useId().replace(/:/g, "")}`;
    if (!definition.revisions.length) return h("span", { className: "ps-wf-bar-text" }, "No revisions yet.");
    const value = revision ?? definition.currentRevision;
    const label = item => chatRevisionOptionLabel(item, { time: item.createdAt ? shownTime(item.createdAt) : null, current: item.revision === definition.currentRevision });
    const shown = definition.revisions.find(item => item.revision === value) ?? null;
    return h(FacedPicker, { id, label: "Rev", labelTitle: "Revision", ariaLabel: "Revision", kind: "is-revision", group: "is-revision", field: "revision",
        face: chatRevisionFace(value), faceTitle: shown ? label(shown) : null, value, onChange: event => onChoose(Number(event.target.value)) },
        definition.revisions.map(item => h("option", { key: item.revision, value: item.revision }, label(item))));
}

/**
 * OF-S2-8 (owner, 2026-11-07T23:18Z): the dimmed line under the Definition and Rev row, for the revision shown: "by Ada
 * Admin · 11:08 · version 0.2.0 · newest", "not valid" when it is (never cut: the line wraps), a package's "from loop-lab
 * 0.2.0 · locked · Make a copy" and its newer version, the last agent test, and Delete… at its end.
 */
function ChatRevisionInfo({ definition, revision, lastTest = null, locked = false, update = null, mayChange = false, packageBusy = null, onCopy, onUseNewer,
    remove = null }) {
    const created = definition.revisions.find(item => item.revision === revision)?.createdAt ?? null;
    const parts = chatRevisionInfoWords(definition, revision, { time: created ? shownTime(created) : null, timeTitle: created ? shownTimeTitle(created) : null });
    const items = [];
    const dot = () => items.push(h("span", { key: `dot${items.length}`, className: "ps-wf-info-dot", "aria-hidden": "true" }, " · "));
    for (const part of parts) {
        if (items.length) dot();
        items.push(h("span", { key: part.key, "data-field": part.key, className: part.key === "not-valid" ? "ps-wf-info-error" : undefined,
            title: part.title ?? undefined }, part.text));
    }
    if (locked && mayChange) {
        if (items.length) dot();
        items.push(h("button", { key: "copy", type: "button", className: "ps-link-button", "data-action": "copy", disabled: packageBusy !== null, onClick: onCopy,
            title: `make an editable copy of ${definition.name} in this chat, at revision 1` }, packageBusy === "copy" ? "Making a copy…" : "Make a copy"));
    }
    if (update) {
        if (items.length) dot();
        items.push(h("span", { key: "update", "data-field": "package-update" }, update));
        if (mayChange) {
            dot();
            items.push(h("button", { key: "use-newer", type: "button", className: "ps-link-button", "data-action": "use-newer", disabled: packageBusy !== null,
                onClick: onUseNewer, title: "Workflows already started keep the version they started with" },
                packageBusy === "update" ? "Taking it…" : "Use it for the next Workflow"));
        }
    }
    if (lastTest) {
        if (items.length) dot();
        // Stage 2.2: the shown revision's last agent test, only after one ran.
        items.push(h("span", { key: "test", className: `ps-wf-last-test is-${lastTest.verdict}`, "data-last-test": lastTest.verdict,
            title: "The chat tests a revision only when you ask it to. A test is not a Workflow." }, lastTest.words));
    }
    if (!items.length && !remove) return null;
    return h("div", { className: "ps-wf-line is-quiet ps-wf-info", role: "status", "data-field": "revision-info",
        "data-chat-definition": locked ? "locked" : undefined },
        h("span", { className: "ps-wf-info-text" }, items),
        remove ? h("span", { className: "ps-wf-info-actions" }, remove) : null);
}

/**
 * The YAML of the revision shown (E2-1, E2-5). For the chat's owner or an admin, when the deployment takes a person's
 * commands, the newest revision is edited here and saved as the next one; an older one is shown as it was saved, with the
 * way to the newest. Anyone else who can read the chat sees no YAML.
 */
function ChatYamlPanel({ controller, ownerId, definition, revision, read, access, changeAccess, tab, setTab, retry }) {
    if (!Number.isSafeInteger(revision)) return h("p", { className: "ps-wf-muted" }, "No revisions yet.");
    // The newest revision, for one who may change it: the editor, kept open while that revision is (re)read, so an edit and
    // a save's answer stay on screen when the list moves on.
    if (changeAccess?.allowed && changeAccess.personCommands && !definition.deleted && !definition.locked && revision === definition.currentRevision
        && read?.phase !== "failed") {
        const ready = read?.phase === "ready" ? read.value : null;
        return h(ChatYamlEditor, { key: definition.definitionId, controller, ownerId, definition, newest: revision,
            newestYaml: ready ? access.yaml : null,
            diagnostics: Array.isArray(ready?.revision?.diagnostics) ? ready.revision.diagnostics : [],
            saved: tab.chatDraft?.definitionId === definition.definitionId ? tab.chatDraft : null,
            keep: draft => setTab({ chatDraft: draft }), onSaved: () => setTab({ chatRevision: "newest" }) });
    }
    if (!read || (read.phase === "loading" && !read.value)) return h("p", { className: "ps-wf-muted" }, `Reading revision ${revision}…`);
    if (read.phase === "failed" && !read.value) {
        return h("p", { className: "ps-wf-line is-error", role: "alert" }, `Revision ${revision} could not be read: ${read.error ?? "no reason given"} `,
            h("button", { type: "button", className: "ps-mini-button", onClick: retry }, "Retry"));
    }
    if (access.yaml === null) {
        return h("p", { className: "ps-wf-muted", "data-field": "yaml-hidden" }, "Only this chat's owner or an admin can read this definition's YAML.");
    }
    const diagnostics = Array.isArray(read.value?.revision?.diagnostics) ? read.value.revision.diagnostics : [];
    const editable = access.allowed && access.personCommands && !definition.deleted && !definition.locked;
    const why = definition.deleted ? `${definition.name} was deleted, so it cannot change.`
        // Stage 2.3 (E2-7): a package's definition is locked; Make a copy (above) makes an editable one.
        : definition.locked ? `${definition.name} comes from the package ${definition.packageName ?? ""} and is locked: it cannot be changed here. `
            + "Make a copy to change it."
        : !access.personCommands ? "This deployment does not take Workflow changes from people; ask the chat to change it."
            : !access.allowed ? access.reason ?? "Only this chat's owner or an admin can change it."
                : `This is revision ${revision}, as it was saved. Edits start from the newest revision, ${definition.currentRevision}.`;
    return h(React.Fragment, null,
        h("p", { className: "ps-wf-muted", "data-field": "yaml-read-only" }, why, " ",
            editable ? h("button", { type: "button", className: "ps-link-button", "data-action": "edit-newest", onClick: () => setTab({ chatRevision: "newest" }) },
                "Edit the newest revision") : null),
        h(WorkflowYamlBox, { value: access.yaml, readOnly: true, marks: workflowDraftMarks(diagnostics), changed: false }));
}

/**
 * The editor of a definition's newest revision (E2-1..E2-5). Save sends the text as the next revision, naming the revision
 * it was based on; a newer one saved meanwhile refuses it, in words that say who saved it and when (E2-3), and Reload then
 * shows the newest (the edit is replaced). An edit not saved survives showing another revision or view (kept in the tab).
 * The errors marked are the saved revision's; a revision with errors is saved with them, and Start refuses it.
 */
function ChatYamlEditor({ controller, ownerId, definition, newest, newestYaml, diagnostics, saved, keep, onSaved }) {
    const [draft, setDraft] = React.useState(() => (saved?.dirty ? { base: saved.base, text: saved.text, dirty: true }
        : { base: newestYaml === null ? null : newest, text: newestYaml, dirty: false }));
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState(null);
    // While nothing is changed here, the editor follows the newest revision (the chat may save one meanwhile).
    React.useEffect(() => {
        // A save just made is newer than the list read before it: the editor waits for the list to catch up.
        if (!draft.dirty && newestYaml !== null && (draft.base === null || newest >= draft.base) && (draft.base !== newest || draft.text !== newestYaml)) {
            setDraft({ base: newest, text: newestYaml, dirty: false });
        }
    }, [draft.dirty, newest, newestYaml]);
    const latest = React.useRef(draft);
    latest.current = draft;
    React.useEffect(() => () => keep(latest.current.dirty ? { definitionId: definition.definitionId, ...latest.current } : null), []);
    const save = async () => {
        setBusy(true);
        setNotice(null);
        // S2UI-F1: what is sent; text typed while the save (and the list read after it) is pending is not lost.
        const submitted = draft.text;
        const result = await controller.saveChatWorkflowDefinition(ownerId, { definitionId: definition.definitionId, name: definition.name, yaml: submitted,
            expectedRevision: draft.base });
        setBusy(false);
        if (result?.ok) {
            const revision = Number.isSafeInteger(result.receipt?.revision) ? result.receipt.revision : draft.base;
            setDraft(current => chatEditorAfterSave(current, submitted, revision));
            setNotice(result.receipt?.valid === false
                ? { level: "error", text: `Saved revision ${revision}. It has errors, so it cannot start until they are fixed.` }
                : { level: "quiet", text: `Saved revision ${revision}.` });
            onSaved();
        } else {
            setNotice({ level: "error", text: chatRefusal("Revision not saved", result, "it was not saved."), stale: result?.stale ?? null,
                unconfirmed: result?.phase === "unconfirmed" });
        }
    };
    const reload = () => {
        setNotice(null);
        setDraft(current => ({ ...current, dirty: false }));
    };
    if (draft.text === null) return h("p", { className: "ps-wf-muted" }, `Reading revision ${newest}…`);
    const behind = draft.dirty && draft.base !== newest;
    const marks = draft.base === newest ? workflowDraftMarks(diagnostics) : { lines: [], unplaced: 0 };
    return h("div", { className: "ps-wf-chat-editor", "data-base-revision": draft.base },
        h("div", { className: "ps-wf-bar is-yaml" },
            h("span", { className: "ps-wf-bar-text" }, draft.dirty ? `Editing revision ${draft.base} · not saved` : `Revision ${draft.base}`),
            h("span", { className: "ps-wf-bar-actions" },
                h(WorkflowToolButton, { label: "Save", glyph: "save", "data-action": "save", disabled: !draft.dirty || busy,
                    title: workflowTabButtonTip("save", { revision: draft.base }), onClick: () => { save(); } }),
                h(WorkflowToolButton, { label: "Discard", glyph: "discard", "data-action": "discard", disabled: !draft.dirty || busy,
                    title: workflowTabButtonTip("discard"), onClick: reload }))),
        behind && !notice ? h("p", { className: "ps-wf-line is-quiet", role: "status", "data-field": "newer-revision" },
            `Revision ${newest} was saved after the one you are editing. Saving will be refused. Reload shows it and replaces your edit. `,
            h("button", { type: "button", className: "ps-mini-button", "data-action": "reload", onClick: reload }, "Reload")) : null,
        notice ? h("p", { className: `ps-wf-line ${notice.level === "error" ? "is-error" : "is-quiet"}`, role: notice.level === "error" ? "alert" : "status",
            "data-field": "save-notice", "data-stale": notice.stale ?? undefined }, notice.text, " ",
            notice.stale ? h("button", { type: "button", className: "ps-mini-button", "data-action": "reload", onClick: reload }, "Reload")
                : notice.unconfirmed ? h("button", { type: "button", className: "ps-mini-button", "data-action": "save-again", onClick: () => { save(); } }, "Try again")
                    : null) : null,
        h(WorkflowYamlBox, { value: draft.text ?? "", marks, changed: draft.dirty,
            onChange: text => setDraft(current => ({ ...current, text, dirty: true })) }));
}

/** Compare (E2-8): any two revisions of the definition side by side; by default the one shown and the one before it. */
function ChatCompare({ controller, ownerId, definition, shown }) {
    const numbers = definition.revisions.map(item => item.revision);
    const to0 = Number.isSafeInteger(shown) && numbers.includes(shown) ? shown : numbers[0] ?? null;
    const from0 = numbers.find(number => number < (to0 ?? 0)) ?? numbers.find(number => number !== to0) ?? null;
    const [choice, setChoice] = React.useState({ from: null, to: null });
    const from = numbers.includes(choice.from) ? choice.from : from0;
    const to = numbers.includes(choice.to) ? choice.to : to0;
    const reads = useControllerSelector(controller, state => state.ui.chatDefinitionReads?.[ownerId] ?? null);
    // Review S2UI-F2: Compare's two reads are kept in the cache while shown, and read again should one go anyway.
    const fromKey = Number.isSafeInteger(from) ? chatDefinitionReadKey(definition.definitionId, from) : null;
    const toKey = Number.isSafeInteger(to) ? chatDefinitionReadKey(definition.definitionId, to) : null;
    React.useEffect(() => {
        if (!ownerId) return undefined;
        controller.dispatch({ type: "ui/chatDefinitionShown", ownerId, role: "from", key: fromKey });
        controller.dispatch({ type: "ui/chatDefinitionShown", ownerId, role: "to", key: toKey });
        return () => {
            controller.dispatch({ type: "ui/chatDefinitionShown", ownerId, role: "from", key: null });
            controller.dispatch({ type: "ui/chatDefinitionShown", ownerId, role: "to", key: null });
        };
    }, [controller, ownerId, fromKey, toKey]);
    const fromMissing = Boolean(fromKey && !reads?.[fromKey]);
    const toMissing = Boolean(toKey && !reads?.[toKey]);
    React.useEffect(() => {
        for (const number of [from, to]) {
            if (Number.isSafeInteger(number)) controller.readChatWorkflowRevision?.(ownerId, definition.definitionId, number)?.catch?.(() => {});
        }
    }, [controller, ownerId, definition.definitionId, from, to, fromMissing, toMissing]);
    if (numbers.length < 2) return h("p", { className: "ps-wf-muted" }, "One revision so far.");
    const read = number => (Number.isSafeInteger(number) ? reads?.[chatDefinitionReadKey(definition.definitionId, number)] ?? null : null);
    const compared = chatRevisionCompare(read(from), read(to), from, to);
    const pick = (label, value, onChange, field) => h("label", { style: { display: "inline-flex", alignItems: "center", gap: 4 } }, label,
        h("select", { className: "ps-workflow-input", value: value ?? "", "data-field": field, onChange: event => onChange(Number(event.target.value)) },
            definition.revisions.map(item => h("option", { key: item.revision, value: item.revision },
                `Revision ${item.revision}${item.revision === definition.currentRevision ? " · newest" : ""}`))));
    return h(CompareView, { label: "Compare revisions", from, to, compared, kind: "revisions",
        pickers: [pick("From", from, value => setChoice(current => ({ ...current, from: value })), "compare-from"),
            pick("To", to, value => setChoice(current => ({ ...current, to: value })), "compare-to")],
        unparsed: "" });
}

/** Delete… (Q8, R6): asks first; refused while one of the definition's Workflows runs, in the server's words. */
function ChatDeleteDialog({ controller, ownerId, definition, onClose, onDeleted }) {
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(null);
    const send = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        const result = await controller.deleteChatWorkflowDefinition(ownerId, { definitionId: definition.definitionId });
        setBusy(false);
        if (result?.ok) onDeleted();
        else setError(chatRefusal("Delete refused", result, "it was not deleted."));
    };
    const words = chatDeleteWords(definition);
    return h(Dialog, { title: `Delete ${definition.name}`, onClose, className: "is-delete",
        footer: [
            h("button", { key: "keep", type: "button", className: "ps-mini-button", onClick: onClose }, "Keep it"),
            h("button", { key: "delete", type: "button", className: "ps-mini-button is-danger", "data-action": "confirm-delete",
                // UX2D-F2: busy is aria-disabled, not disabled, so the focused button keeps focus while the request runs.
                "aria-disabled": busy || undefined, onClick: send },
                busy ? "Deleting…" : "Delete"),
        ] },
        // UX2D-F10: in agreeing number, and the running rule only when one runs.
        h("p", null, words.what),
        h("p", { className: "ps-wf-muted", "data-field": "delete-keep" }, words.keep),
        error ? h("p", { role: "alert", className: "ps-wf-line is-error" }, error) : null);
}

/** The state chip of a Workflow whose row is not loaded: its run's status as the list read it. */
export function listedState(runStatus) {
    if (!runStatus) return null;
    // OF-S2-2 part 2 (D-W9): the words module's one word per state; admitted (accepted, not begun) is Running, as everywhere.
    // Review 18:45Z (D-W1): a stop either way reads Canceled; the tooltip says which.
    const key = { admitted: "running", running: "running", paused: "paused", completed: "completed", failed: "failed", cancelled: "canceled", stopped: "canceled" }[runStatus];
    // Review 19:10Z: every stored status has its words; one this portal does not know reads "Not certain", the stored value in
    // the tooltip only.
    const title = runStatus === "stopped" ? "Canceled after started nodes finished" : runStatus === "cancelled" ? "Canceled at once"
        : key ? null : `Status not known here: ${runStatus}`;
    return { key: key ?? "not-certain", label: key ? WORKFLOW_RUN_STATE_WORDS[key] : WORKFLOW_RUN_STATE_WORDS.notCertain, title,
        tone: runStatus === "failed" ? "failed" : runStatus === "running" ? "running" : "quiet" };
}

/** The Workflows view: one row per Workflow of the definition, newest first, each with the revision it runs (R1). */
function ChatWorkflowList({ controller, definition, byId, views, onOpen, onStart, onShowRevision }) {
    const rows = [...definition.workflows].reverse();
    const histories = useControllerSelector(controller, state => state.history.bySessionId);
    const stamp = rows.map(row => `${row.sessionId}:${byId?.[row.sessionId]?.updatedAt ?? ""}`).join(",");
    React.useEffect(() => {
        for (const row of rows.slice(0, LIST_READ_LIMIT)) {
            if (!byId?.[row.sessionId]) continue;
            controller.ensureSessionHistory(row.sessionId).catch(() => {});
            controller.ensureWorkflowReadModel(row.sessionId).catch(() => {});
        }
    }, [controller, stamp]);
    const startable = !definition.deleted && Number.isSafeInteger(definition.newestValidRevision);
    const drafts = definition.drafts;
    return h("div", { className: "ps-wf-body" },
        // Q5: a stage 1 Workflow that never started was imported as a revision; it is shown as that revision.
        // Review 19:10Z: the " · " pattern in plain words; where they came from is the tooltip.
        drafts.length ? h("p", { className: "ps-wf-line is-quiet", role: "status", "data-field": "imported-drafts",
            title: "Made before definitions had revisions, and never started" },
            `Not started · imported · ${drafts.length === 1 ? "revision" : "revisions"} ${drafts.map(item => item.revision).join(", ")} `,
            h("button", { type: "button", className: "ps-link-button", "data-action": "show-imported", onClick: () => onShowRevision(drafts[drafts.length - 1].revision) },
                "Show it")) : null,
        rows.length === 0
            ? h("div", { className: "ps-wf-empty" }, h("p", null, "No Workflows yet."), startable
                ? h("button", { type: "button", className: "ps-mini-button is-primary", "data-action": "start", onClick: onStart }, "Start…") : null)
            : h("div", { className: "ps-wf-list", role: "table", "aria-label": `Workflows of ${definition.name}` },
                h("div", { className: "ps-wf-list-row is-head", role: "row" },
                    ["#", "State", "Revision", "Started", "Took"].map(label => h("span", { key: label, role: "columnheader" }, label))),
                rows.map(row => {
                    const session = byId?.[row.sessionId] ?? null;
                    const view = views?.[row.sessionId] ?? null;
                    const state = session ? workflowStateOf(session, view) : listedState(row.runStatus);
                    const model = workflowChildModel(view);
                    const live = Array.isArray(model?.runs) ? model.runs.find(run => run?.mode === "live") ?? null : null;
                    const times = workflowRunTimes(histories?.get?.(row.sessionId)?.events, live?.runId ?? null);
                    const reason = state?.key === "failed" && model?.run && model.run.mode !== "test" ? workflowFailure(model.run)?.reason ?? null : null;
                    const started = times.started !== null ? shownTime(times.started) : row.createdAt ? shownTime(row.createdAt) : null;
                    return h("div", { key: row.sessionId, role: "row", className: "ps-wf-list-row is-action", "data-session-id": row.sessionId,
                        "data-revision": row.revision ?? undefined, onClick: event => { if (!event.target.closest?.("button")) onOpen(row.sessionId); } },
                        h("span", { role: "cell", className: "ps-wf-list-number" },
                            h("button", { type: "button", className: "ps-link-button", "aria-label": `Open ${definition.name} #${row.number}`,
                                onClick: () => onOpen(row.sessionId) }, `#${row.number}`)),
                        h("span", { role: "cell", className: "ps-wf-list-state" }, h(StateChip, { state }),
                            reason ? h("span", { className: "ps-wf-list-reason" }, reason) : null),
                        h("span", { role: "cell", className: "ps-wf-list-version" }, Number.isSafeInteger(row.revision) ? `revision ${row.revision}` : "—"),
                        h("span", { role: "cell", className: "ps-wf-list-started" }, started ?? "—"),
                        h("span", { role: "cell", className: "ps-wf-list-took" }, times.took !== null ? workflowElapsedText(times.took) : "—"));
                })),
        rows.length && startable ? h("div", { className: "ps-wf-bar is-foot" },
            h(WorkflowToolButton, { label: "Start…", glyph: "start", "data-action": "start",
                title: `start Workflow #${chatNextWorkflowNumber(definition)} from revision ${definition.newestValidRevision}`, onClick: onStart })) : null);
}

/** One Workflow of a chat's definition: the stage 1 Workflow view, with the revision it runs and Run again… (the same revision, Q10). */
function ChatRunView({ controller, ownerId, definition, workflow, tab, setTab, mobile, phone, displayMode, onOpen, nodeStateId }) {
    const revision = workflow.revision;
    const { read } = useChatRevisionRead(controller, ownerId, definition.definitionId, revision);
    const control = startControlOf(definition, revision, read);
    const view = useControllerSelector(controller, state => state.ui.workflowViews?.[workflow.sessionId] ?? null);
    const chatModelKey = useControllerSelector(controller, state => workflowSessionModelKey(state.sessions.byId, ownerId));
    const chatModel = React.useMemo(() => workflowModelFromKey(chatModelKey), [chatModelKey]);
    const [again, setAgain] = React.useState(false);
    const nextNumber = chatNextWorkflowNumber(definition);
    const extraActions = h(WorkflowToolButton, { label: "Run again…", glyph: "start-another", "data-action": "run-again-dialog", disabled: !control.enabled,
        title: control.enabled ? `start Workflow #${nextNumber} from revision ${revision}, the revision #${workflow.number} ran` : control.title,
        onClick: () => setAgain(true) });
    return h(React.Fragment, null,
        h(WorkflowRunView, { controller, definition, workflow, tab, setTab, mobile, phone, displayMode, onOpen, nodeStateId, chatRevision: revision, extraActions }),
        again ? h(StartDialog, { controller, sessionId: definition.definitionId, name: definition.name, number: nextNumber,
            source: { number: workflow.number, inputs: workflowRunInputs(workflowChildModel(view)) },
            // UX2D-F9: once its revision is read, its schema is the contract (none: it takes no inputs), as Start's is.
            publication: { inputsSchema: read?.value?.graph?.inputsSchema ?? null, inputsSchemaKnown: read?.phase === "ready" && Boolean(read?.value?.graph),
                revision, publishedRevision: revision, state: "published", valid: true },
            // OF-S2-7: Run again reuses the models #N's start chose; the other agent nodes use the chat's.
            models: workflowStartModels(read?.value?.graph?.states, { chosen: workflowChildModel(view)?.run?.agentModels ?? null, chat: chatModel }),
            control: { operation: "start", enabled: true },
            startWith: ({ inputs, vars }) => controller.startChatWorkflowDefinition(ownerId, { definitionId: definition.definitionId, runAgainOf: workflow.sessionId,
                inputs, vars }),
            onClose: () => setAgain(false),
            onStarted: result => { setAgain(false); onOpen(result?.receipt?.workflowId ?? null); } }) : null);
}
