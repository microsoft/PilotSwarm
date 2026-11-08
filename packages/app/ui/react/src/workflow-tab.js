import React from "react";
import { createPortal } from "react-dom";
import { useControllerSelector } from "./use-controller-state.js";
import { selectWorkflowViewSnapshotFor, workflowNodeViews, workflowParentWorking, workflowReadModelView, workflowViewSnapshotEqual } from "../../core/src/workflow-view.js";
import {
    formatSeconds, projectWorkflowV2, workflowLogEvents, workflowLogWindow, workflowV2Activity, workflowV2BranchPickKey, workflowV2ReplayBranchIndex, workflowV2ReplayFrames,
    workflowV2ReplayLabel, workflowV2SelectionAfterBranchChange,
} from "../../core/src/workflow-v2-view.js";
import {
    WORKFLOW_V2_TEST_NEEDS_DRAFT_TEXT, workflowV2DefinitionControls, workflowV2DraftEditor, workflowV2JsonObjectDraft, workflowV2RunCommandNotice,
    workflowV2RunControls, workflowV2RunVariables, workflowV2SampleInputs, workflowV2TestControls, workflowV2TestModeListed, workflowV2TestResponder,
    workflowV2DrawableInput, workflowV2InputsShape, workflowV2RunInputs, workflowV2StartAnotherShape,
} from "../../core/src/workflow-v2-commands.js";
import { workflowModelFromKey, workflowRefusalText, workflowRunsText, workflowSessionModelKey, workflowShortTime, workflowTimeTitle,
    workflowV1NodeWords } from "../../core/src/workflow-words.js";
import { AUTO_HISTORY_EVENT_SOFT_CAP } from "../../core/src/controller.js";
import { workflowNodeSummary } from "../../core/src/workflow-node-summary.js";
import {
    WORKFLOW_AGENT_LOG_VISITS, workflowAgentLogChats, workflowAgentNodeLog, workflowBaseInstructionsMatch, workflowBaseInstructionsReadable,
} from "../../core/src/workflow-agent-log.js";
import {
    selectWorkflowTabContext, workflowChildModel, workflowDefinitionName, workflowDefinitionsOf, workflowElapsedText, workflowFailure,
    workflowPanelHeight, workflowPanelIsSide, workflowPanelWidth, workflowPickerFace, workflowPickerGroupLabel, workflowPickerOptionLabel, workflowRunTimes, workflowStarted,
    workflowStateOf, workflowChildDefinitionFacts, workflowDefinitionHeaderText, workflowDefinitionOptionLabel, workflowListVersionText,
    workflowUnstartedChildren, workflowUnstartedLine, workflowChosenVersion, workflowDefinitionVersions, workflowVersionFromOptionValue,
    workflowVersionOptionValue, workflowVersionChoice, workflowVersionChoicePatch, workflowPickerChoicePatch, workflowVersionDiscriminator, workflowVersionReadIds, workflowMadeNumbers, workflowMadeWords,
    workflowTabButtonTip, workflowTabContextEqual, WORKFLOW_DEFINITION_PANELS,
    WORKFLOW_GRAPH_MIN_WIDTH, WORKFLOW_PANEL_HEIGHT_MIN, WORKFLOW_PANEL_WIDTH_MIN, WORKFLOW_RUN_PANELS,
} from "../../core/src/workflow-owner.js";
import {
    WorkflowV2AgentLog, WorkflowV2Diagnostics, WorkflowV2DraftEditor, WorkflowV2FailureDetails, WorkflowV2NoGraph, WorkflowV2NodeSummary, WorkflowV2RevisionCompare,
    WorkflowV2RunCommandNotice, WorkflowV2VersionCompare,
    WorkflowV2RunPicker, WorkflowV2TestAnswer, WorkflowV2TestClock, WorkflowV2TestInterceptions, WorkflowV2TestPanel, WorkflowV2Variables,
    WorkflowV2YamlView,
} from "./workflow-v2-panels.js";
import { WorkflowGraph } from "./workflow-graph.js";
import { workflowLifecycleAtOf } from "../../core/src/workflow-lifecycle.js";
import { WorkflowToolButton } from "./workflow-tool-button.js";
import { NodeCodeSections } from "./workflow-code.js";
import { PHONE_MEDIA_QUERY, useMediaQuery } from "./use-media-query.js";
import { ModalDialog, dialogKey } from "./modal-dialog.js";
import { ChatWorkflowTab } from "./workflow-chat-tab.js";
import { chatDefinitionsLoaded, chatDefinitionsModel, chatDefinitionsStamp, chatWorkflowTabKind } from "../../core/src/workflow-chat-definitions.js";

const h = React.createElement;
const EMPTY = Object.freeze({});
const EMPTY_EVENTS = Object.freeze([]);
export const LIST_READ_LIMIT = 10;
/** Stage 2.4 (FU-26): how long the replay shows each visit while it plays. */
export const REPLAY_STEP_MS = 800;

/**
 * Workflow Simplified, stage 1 (spec draft 3, sections 06–08, 11, 12): the Workflow tab. It shares the right block with
 * the canvas (L1) and shows the definitions of the session whose chat is in the middle, or the Workflow of the agent
 * node chat that is: a header row (the definition picker and the Definition | Workflows switch, L4), then the
 * definition's graph or its Workflows, and a bottom panel (L5), closed by default. On a phone the bottom panel is a
 * sheet with a visible way back (12).
 *
 * On the tested engine each Workflow is still a workflow child session; this tab reads them through the same reads the
 * old workflow screen made (ensureWorkflowDefinition, ensureWorkflowReadModel, the session's events) and sends the same
 * commands (sendWorkflowRunCommand). Every command is the server's decision.
 */

/** One workflow child's view parts, fresh for `sessionId` (a store change for another child is never paired with it). */
function useWorkflowChild(controller, sessionId) {
    const selected = useControllerSelector(controller, state => selectWorkflowViewSnapshotFor(state, sessionId), workflowViewSnapshotEqual);
    const snapshot = selected.sessionId === (sessionId ?? null) ? selected : selectWorkflowViewSnapshotFor(controller.getState(), sessionId);
    const { session, history, canvas, view, places } = snapshot;
    const events = history?.events || EMPTY_EVENTS;
    const selectedRunId = view.selectedRunId ?? null;
    const sessionUpdatedAt = session?.updatedAt ?? null;
    // New events, another run selection or a changed session row ask for the read model again (as the workflow screen did).
    React.useEffect(() => {
        if (sessionId) controller.ensureWorkflowDefinition(sessionId);
    }, [controller, sessionId, events, selectedRunId, sessionUpdatedAt]);
    const { readModel, readModelAfterSeq, workflowModel, error } = workflowReadModelView(view);
    const olderHistory = view.olderHistory ?? null;
    const live = canvas?.dataPayload;
    // OF-S2-7: the model of the chat that owns the Workflow (its agent nodes use it unless their start chose one).
    const chatModelKey = useControllerSelector(controller, state => workflowSessionModelKey(state.sessions.byId,
        state.sessions.byId?.[sessionId]?.parentSessionId ?? null));
    const chatModel = React.useMemo(() => workflowModelFromKey(chatModelKey), [chatModelKey]);
    const projection = React.useMemo(() => {
        if (view.definition?.shape !== "v2" && !readModel && !workflowModel) return null;
        const projected = projectWorkflowV2({ definition: view.definition, readModel, workflowModel, selectedRunId, events, readModelAfterSeq, olderHistory, chatModel });
        return !projected.definition && view.definition && view.definition.shape !== "v2" ? null : projected;
    }, [view.definition, readModel, workflowModel, selectedRunId, readModelAfterSeq, events, olderHistory, chatModel]);
    const legacyNodes = React.useMemo(() => projection ? [] : workflowNodeViews(view.definition, events, live), [projection, view.definition, events, live]);
    // Stage 2.4 (FU-26, the replay): the same projection as it stood at a moment (epoch milliseconds).
    const projectAt = React.useCallback(asOf => projectWorkflowV2({ definition: view.definition, readModel, workflowModel, selectedRunId, events,
        readModelAfterSeq, olderHistory, asOf, chatModel }), [view.definition, readModel, workflowModel, selectedRunId, readModelAfterSeq, events, olderHistory, chatModel]);
    return { sessionId, session, view, places, events, olderEvents: history?.hasOlderEvents === true, projection, projectAt, readModel, workflowModel, readError: error, legacyNodes,
        definition: projection ? projection.definition : view.definition, nodes: projection ? projection.nodes : legacyNodes };
}

/** The definition's graph with no run on it (07): the same read model, without overlaying any run. */
function useDefinitionProjection(child) {
    const { view, workflowModel } = child;
    return React.useMemo(() => {
        if (view.definition?.shape !== "v2" && !workflowModel) return null;
        return projectWorkflowV2({ definition: view.definition, readModel: null, workflowModel, selectedRunId: null, events: EMPTY_EVENTS });
    }, [view.definition, workflowModel]);
}

/** A time people read (D-W7, workflowShortTime): the clock alone when it is today, else the date too; local, no zone. */
export function shownTime(value) {
    return workflowShortTime(value);
}

/** A time's tooltip: the local date, clock and zone (workflowTimeTitle). */
export function shownTimeTitle(value) {
    return workflowTimeTitle(value);
}

/**
 * The tone class of a state chip. `text` replaces its label; `time` (a phone: the time taken) follows the label in a part
 * of its own that never gives way, so a narrow bar cuts the label, never the time (UX2D-F12); `title` says more on hover.
 */
export function StateChip({ state, className = "", text = null, title = null, time = null }) {
    if (!state) return null;
    return h("span", { className: `ps-wf-state is-${state.tone}${time ? " has-time" : ""}${className ? ` ${className}` : ""}`, "data-state": state.key,
        title: title || state.title || undefined },
        time ? h(React.Fragment, null, h("span", { className: "ps-wf-state-label" }, text ?? state.label), h("span", { className: "ps-wf-state-time" }, ` · ${time}`))
            : text ?? state.label);
}

/**
 * The Workflow tab (06). `modeButtons`: zen and full screen (a phone: maximize), the canvas's own, at the right end of the
 * tab's header when the tab is in the right block (owner, 2026-11-06T06:28Z); none where it is shown in the middle.
 */
export function WorkflowTab(props) {
    const { controller } = props;
    const context = useControllerSelector(controller, selectWorkflowTabContext, workflowTabContextEqual);
    const ownerId = context.ownerId;
    // Stage 2.1b: the chat's own definitions, read again when the chat's row or its Workflows change.
    const stamp = useControllerSelector(controller, state => chatDefinitionsStamp(state.sessions.byId, ownerId));
    const entry = useControllerSelector(controller, state => (ownerId ? state.ui.chatDefinitions?.[ownerId] ?? null : null));
    React.useEffect(() => {
        if (ownerId) controller.ensureChatWorkflowDefinitions?.(ownerId)?.catch?.(() => {});
    }, [controller, ownerId, stamp]);
    // UX2D-F6: a revision saved from another page changes neither the chat's row nor its Workflows; the list is read again
    // when this page comes back (it is shown again, or the window takes focus), so the editor says a newer one was saved.
    React.useEffect(() => {
        if (!ownerId || typeof window === "undefined" || typeof document === "undefined") return undefined;
        const again = () => {
            if (document.visibilityState === "hidden") return;
            controller.ensureChatWorkflowDefinitions?.(ownerId, { force: true })?.catch?.(() => {});
        };
        window.addEventListener("focus", again);
        document.addEventListener("visibilitychange", again);
        return () => {
            window.removeEventListener("focus", again);
            document.removeEventListener("visibilitychange", again);
        };
    }, [controller, ownerId]);
    const items = chatDefinitionsLoaded(entry) ? entry.items : null;
    const definitions = React.useMemo(() => (items ? chatDefinitionsModel(items) : null), [items]);
    // A connection without chat definitions, a list not read yet, a Workflow shown that no definition lists, or (review
    // S2UI-F4) no definitions while the chat has Workflow children: the chat's Workflows grouped by name, as stage 1 shows them.
    const byId = useControllerSelector(controller, state => state.sessions.byId);
    if (chatWorkflowTabKind(definitions, { ownerId, workflowId: context.workflowId, byId }) === "chat") {
        return h(ChatWorkflowTab, { ...props, context, definitions, listError: entry?.error ?? null });
    }
    return h(StageOneWorkflowTab, props);
}

/** The stage 1 Workflow tab: a chat's Workflows grouped by definition name, each version its own child. */
function StageOneWorkflowTab({ controller, mobile = false, modeButtons = null, displayMode = "normal" }) {
    // Owner, 2026-11-06T13:43Z: on a phone (600 px or less) the graph gets the height: two header rows, no meta line.
    const phone = useMediaQuery(PHONE_MEDIA_QUERY) && mobile;
    const context = useControllerSelector(controller, selectWorkflowTabContext, workflowTabContextEqual);
    // Owner, 2026-11-06T14:35Z (F4): this tab is mounted only while it is shown; it records what it showed, as the canvas
    // records the revision it rendered, and the Workflow button's dot clears. OF-S2-4 (C): every lifecycle change counts.
    const attentionAt = useControllerSelector(controller, state => workflowLifecycleAtOf(state, context.ownerId));
    React.useEffect(() => {
        // OF-S2-4d: shown once is a receipt even before any lifecycle change (1 ms: older than every change), so the panel
        // never opens by itself again for this chat.
        if (context.ownerId) controller.dispatch({ type: "canvas/viewed", sessionId: context.ownerId, workflowAt: Math.max(attentionAt, 1) });
    }, [controller, context.ownerId, attentionAt]);
    const byId = useControllerSelector(controller, state => state.sessions.byId);
    const views = useControllerSelector(controller, state => state.ui.workflowViews);
    const tabs = useControllerSelector(controller, state => state.ui.workflowTabs);
    const ownerId = context.ownerId;
    const shownId = context.workflowId;
    const shownSession = shownId ? byId?.[shownId] ?? null : null;
    const key = ownerId ?? shownId;
    const tab = (key && tabs?.[key]) || EMPTY;
    const setTab = React.useCallback(patch => {
        if (key) controller.dispatch({ type: "ui/workflowTab", ownerId: key, patch });
    }, [controller, key]);
    const definitions = React.useMemo(() => {
        const owned = ownerId ? workflowDefinitionsOf(byId, ownerId, views) : [];
        if (owned.length || !shownSession) return owned;
        // A Workflow whose session is not loaded: its own definition alone.
        const view = views?.[shownId] ?? null;
        const started = workflowStarted(shownSession, view);
        return [{ name: workflowDefinitionName(shownSession, view), children: [shownId], workflows: started ? [{ sessionId: shownId, number: 1 }] : [],
            newestId: shownId, startable: !started }];
    }, [byId, ownerId, views, shownId, shownSession]);
    const shownName = shownSession ? workflowDefinitionName(shownSession, views?.[shownId] ?? null) : null;
    const definition = definitions.find(item => item.name === (tab.definition ?? shownName)) ?? definitions.find(item => item.name === shownName)
        ?? definitions[0] ?? null;
    const view = tab.view === "definition" || tab.view === "workflows" ? tab.view : shownId ? "workflows" : "definition";
    const workflow = shownId && definition ? definition.workflows.find(item => item.sessionId === shownId) ?? null : null;
    // F9 (owner, 2026-11-06T19:40Z): the Definition view shows the definition's newest child, or one not started that the
    // person chose from the Workflows view (every child that has not started is reachable there).
    // Owner, 2026-11-07T00:03Z: versions are first-class. The picker lists each version of a name (review UI3-F9: and each
    // definition of one version, when children of that version hold different YAML); the Definition view, its YAML and
    // Start… follow the entry chosen there (its newest child). Review UI3-F9: with none chosen, the Definition view shows the
    // Workflow shown (or last shown) itself, never a sibling of the same version; else the definition's newest child.
    const versions = React.useMemo(() => (definition ? workflowDefinitionVersions(byId, definition, views) : []), [definition, byId, views]);
    const runShown = view === "workflows" && Boolean(workflow);
    // Review UI4-F2: while a Workflow is shown, the picker and the Definition view describe it, never a child shown before.
    const chosenChild = !runShown && definition && typeof tab.definitionChild === "string" && definition.children.includes(tab.definitionChild)
        ? tab.definitionChild : null;
    // Review UI4-F1: a version choice is stored as a child (versionChild), stable while that child is read or revised; an
    // earlier shape is resolved (review UI4-F3). A chosen child that is gone shows the newest, and says so.
    const choice = runShown || !definition ? null : workflowVersionChoice(versions, tab, definition.children);
    const ownChild = runShown || !choice ? workflow?.sessionId ?? null : null;
    const chosenVersion = workflowChosenVersion(versions, { child: chosenChild ?? choice?.child ?? ownChild, workflowId: choice ? null : workflow?.sessionId ?? null,
        newestId: definition?.newestId ?? null });
    const choiceShown = choice?.child ? (chosenVersion?.children.includes(choice.child) ? chosenVersion.newestId : choice.child) : null;
    const shownChildId = definition ? chosenChild ?? choiceShown ?? ownChild ?? chosenVersion?.newestId ?? definition.newestId : null;
    // Review UI5-F1: the stored choice follows the child the view shows (a newer child of the same version and definition),
    // so a revision of that child keeps the view on it; an earlier shape is stored as its child (UI4-F3).
    const choicePatch = runShown || !definition ? null : workflowVersionChoicePatch(versions, tab, definition.children);
    const choicePatchKey = choicePatch ? JSON.stringify(choicePatch) : null;
    React.useEffect(() => {
        if (choicePatch) setTab(choicePatch);
    }, [setTab, choicePatchKey]);
    const shownDefinition = React.useMemo(() => {
        if (!definition) return definition;
        return shownChildId === definition.newestId ? definition
            : { ...definition, newestId: shownChildId, startable: !workflowStarted(byId?.[shownChildId], views?.[shownChildId] ?? null) };
    }, [definition, shownChildId, byId, views]);
    // F9: the definitions' newest children and the children not started are read, so the picker and the Workflows view can
    // say each one's version and whether it is a draft; then every other child not read yet, once, for its version (a
    // child's version never changes). At most LIST_READ_LIMIT at a time; a read of an unchanged one is skipped.
    // Review UI3-F3: the bound is taken after the children that need no read are left out (read for their row as it is, and
    // not failed), so the queue moves on as reads complete; one whose read failed is asked again after a pause.
    const toRead = React.useMemo(() => workflowVersionReadIds(definitions, byId, views, id => controller.workflowReadWanted?.(id) ?? true, LIST_READ_LIMIT),
        [controller, definitions, byId, views]);
    const readStamp = toRead.map(id => `${id}:${byId?.[id]?.updatedAt ?? ""}`).join(",");
    React.useEffect(() => {
        for (const id of toRead) controller.ensureWorkflowReadModel(id).catch(() => {});
    }, [controller, readStamp]);
    // A failed Workflow counts on the badge until it is opened (O6).
    const shownState = workflow ? workflowStateOf(shownSession, views?.[shownId] ?? null) : null;
    React.useEffect(() => {
        if (workflow && view === "workflows" && shownState?.key === "failed") controller.dispatch({ type: "ui/workflowSeen", sessionId: workflow.sessionId });
    }, [controller, workflow?.sessionId, view, shownState?.key]);
    // Opening one Workflow, here or in the session list, selects its row (W2); going back to the list selects the session.
    const openWorkflow = React.useCallback(id => {
        setTab({ view: "workflows", workflowId: id, definition: definition?.name ?? null, definitionChild: null, versionChild: null, versionKey: null,
            version: null });
        const target = id ?? ownerId;
        if (target) controller.dispatch({ type: "sessions/selected", sessionId: target });
    }, [controller, setTab, ownerId, definition?.name]);
    const askChat = React.useCallback(text => {
        controller.setPrompt(text, text.length);
        if (typeof document !== "undefined") document.querySelector(".ps-prompt-input")?.focus?.();
    }, [controller]);
    if (!definition) {
        // D8: nothing to show yet.
        return h("section", { className: "ps-wf-tab is-empty", "aria-label": "Workflow" },
            // The way back from full screen stays, even with nothing to show.
            modeButtons ? h("header", { className: "ps-wf-tab-head" }, h("span", { className: "ps-wf-tab-modes" }, modeButtons)) : null,
            h("div", { className: "ps-wf-empty" },
                h("p", { className: "ps-wf-empty-title" }, "No definitions yet."),
                h("p", null, "Ask the chat to create one.")));
    }
    return h("section", { className: `ps-wf-tab${mobile ? " is-mobile" : ""}${phone ? " is-phone" : ""}`, "aria-label": "Workflow", "data-view": view,
        "data-definition": definition.name, "data-version": chosenVersion?.version ?? undefined },
        h("header", { className: "ps-wf-tab-head" },
            h(DefinitionPicker, { definitions, chosen: definition, versions, chosenVersion, byId, views,
                onChoose: value => setTab(workflowPickerChoicePatch(value, { definitions, definition, versions, byId, views })) }),
            // Owner, 2026-11-06T13:43Z (F1): two icon toggles with tooltips; no count beside the definition (F2: it is in the
            // Workflow picker).
            h("div", { className: "ps-wf-switch is-icons", role: "group", "aria-label": "Definition or Workflows" },
                h(WorkflowToolButton, { label: "Definition", glyph: "definition", title: workflowTabButtonTip("definition"),
                    "aria-pressed": view === "definition", onClick: () => setTab({ view: "definition" }) }),
                h(WorkflowToolButton, { label: "Workflows", glyph: "workflows", title: workflowTabButtonTip("workflows"),
                    "aria-pressed": view === "workflows", onClick: () => setTab({ view: "workflows" }) })),
            modeButtons ? h("span", { className: "ps-wf-tab-modes" }, modeButtons) : null),
        view === "definition"
            ? h(DefinitionView, { key: shownDefinition.newestId, controller, definition: shownDefinition, tab, setTab, mobile, displayMode,
                // "Not the newest" only for a child the person chose that is not its entry's newest (one of the same definition).
                newestId: chosenChild ? chosenVersion?.newestId ?? definition.newestId : shownChildId,
                onShowNewest: () => setTab({ definitionChild: null, versionChild: chosenVersion?.newestId ?? null, versionKey: null, version: null }),
                ownerTitle: byId?.[ownerId]?.title ?? null, gone: Boolean(choice?.gone) && !chosenChild,
                versions: versionSides(versions, views, byId, madeNumbersOf(byId, definition, views)), chosenVersion: chosenVersion?.key ?? null,
                ownerWorking: ownerId ? workflowParentWorking(byId?.[ownerId]) : false, onStarted: id => openWorkflow(id), askChat })
            : workflow
                ? h(WorkflowRunView, { key: workflow.sessionId, controller, definition, workflow, tab, setTab, mobile, phone, displayMode, onOpen: openWorkflow,
                    nodeStateId: context.nodeStateId })
                : h(WorkflowList, { controller, definition, byId, views, onOpen: openWorkflow,
                    // The list is the whole name: its Start… and Start another… are the definition's newest child's.
                    onStart: () => setTab({ view: "definition", start: true, definitionChild: definition.newestId, versionChild: null, versionKey: null, version: null }),
                    onAnother: () => setTab({ view: "definition", another: true, definitionChild: definition.newestId, versionChild: null, versionKey: null,
                        version: null }),
                    // F9: a child not started, shown in the Definition view (and its Start form opened, `start`).
                    onShowChild: (id, { start = false } = {}) => setTab({ view: "definition", definitionChild: id, ...(start ? { start: true } : {}) }) }));
}

/**
 * D1: the session's definitions, each version its own option (owner, 2026-11-07T00:03Z: versions are first-class), highest
 * version first: "name · 1.1.0", "name · 1.0.0", with draft or not started where it applies. OF-S2-8 (owner, 2026-11-07T23:15Z): no
 * "ask the chat" option; the empty tab says to ask the chat.
 * No count of Workflows beside the definition (owner, 2026-11-06T13:43Z): the Workflow picker says how many. The chosen
 * definition's versions are `versions`; another definition's are worked out here from the same rows.
 */
function DefinitionPicker({ definitions, chosen, versions, chosenVersion, byId, views, onChoose }) {
    const id = `wf-def-${React.useId().replace(/:/g, "")}`;
    const options = [];
    for (const definition of definitions) {
        const list = definition === chosen ? versions : workflowDefinitionVersions(byId, definition, views);
        const numbers = madeNumbersOf(byId, definition, views);
        for (const entry of list.length ? list : [{ key: null, version: null, newestId: definition.newestId, startable: definition.startable }]) {
            const facts = workflowChildDefinitionFacts(views?.[entry.newestId] ?? null);
            const made = byId?.[entry.newestId]?.createdAt != null ? shownTime(byId[entry.newestId].createdAt) : null;
            options.push({
                value: workflowVersionOptionValue({ name: definition.name, key: entry.key, newest: entry.newestId === definition.newestId }),
                label: workflowDefinitionOptionLabel({ name: definition.name, version: entry.version, state: facts.state, started: !entry.startable,
                    discriminator: workflowVersionDiscriminator(entry, made, numbers.get(entry.newestId) ?? null) }),
                chosen: definition === chosen && (chosenVersion ? entry.key === chosenVersion.key : entry.newestId === definition.newestId),
            });
        }
    }
    const value = options.find(option => option.chosen)?.value ?? chosen.name;
    return h("span", { className: "ps-wf-picker" },
        h("label", { htmlFor: id, className: "ps-sr-only" }, "Workflow definition"),
        h("select", { id, className: "ps-workflow-input ps-wf-picker-select", value,
            onChange: event => onChoose(event.target.value) },
            options.map(option => h("option", { key: option.value, value: option.value }, option.label))));
}

/**
 * Review UI4-F4: the numbers that tell apart a definition's children not started that read alike (the same version, made in
 * the same shown second): workflowMadeNumbers, with each creation time as shown here.
 */
function madeNumbersOf(byId, definition, views) {
    return workflowMadeNumbers(workflowUnstartedChildren(byId, definition, views), item => (item.createdAt != null ? shownTime(item.createdAt) : null));
}

/**
 * Each entry's side for Compare (review UI3-F9: one per definition of a version): its key, its words ("1.1.3", or
 * "1.1.3 · #2, #4" when the version has more than one definition), its newest child, that child's current revision and its
 * read of that revision.
 */
function versionSides(versions, views, byId = {}, numbers = new Map()) {
    return versions.filter(entry => entry.version !== null).map(entry => {
        const view = views?.[entry.newestId] ?? null;
        const revision = workflowChildDefinitionFacts(view).revision;
        const made = byId?.[entry.newestId]?.createdAt != null ? shownTime(byId[entry.newestId].createdAt) : null;
        const discriminator = workflowVersionDiscriminator(entry, made, numbers.get(entry.newestId) ?? null);
        return { key: entry.key, version: entry.version, label: [entry.version, discriminator].filter(Boolean).join(" · "),
            sessionId: entry.newestId, revision, read: Number.isSafeInteger(revision) ? view?.definitionRevisions?.[revision] ?? null : null };
    });
}

/**
 * The definition's newest revision line (07, D3), when it is not valid: one line over the graph. While the session that
 * owns it is still working (its chat is in a turn: it is writing the definition), the line is calm (owner batch 7, H1):
 * `{ text, calm }`, or null for a valid revision.
 */
export function revisionLine(model, { writing = false, writer = null } = {}) {
    const revision = model?.revision;
    if (!revision || !Number.isSafeInteger(revision.revision)) return null;
    if (revision.valid !== false) return null;
    const diagnostics = (Array.isArray(revision.diagnostics) ? revision.diagnostics : []).filter(item => item && item.severity !== "warning");
    const first = diagnostics[0] ?? null;
    const where = first && Number.isSafeInteger(first.line) ? `line ${first.line}: ` : "";
    const why = first?.message ? ` · ${where}${first.message}` : "";
    const graphRevision = Number.isSafeInteger(model?.graph?.revision) && model.graph.revision !== revision.revision ? model.graph.revision : null;
    const showing = graphRevision ? ` Showing revision ${graphRevision}.` : "";
    if (writing) {
        const count = diagnostics.length;
        return { calm: true, text: `${writer ?? "The chat"} is still writing this definition. Revision ${revision.revision} has `
            + `${count || "unlisted"} error${count === 1 ? "" : "s"} so far.${showing}` };
    }
    return { calm: false, text: `Revision ${revision.revision} not valid${why}.${showing}` };
}

/**
 * The selected node in the Definition view (D9 Node; finding 7): what it does in one sentence, its input and time limit,
 * an agent node's chat and what its agent is told, and where each outcome goes, in the words the run's Node panel uses
 * (workflowNodeSummary). No run: nothing about visits or results.
 */
export function NodeFacts({ node, yaml = null, pending = false, hidden = null }) {
    if (!node) return h("p", { className: "ps-wf-muted" }, "Select a node to see it.");
    const row = (label, value, title = null) => value === null || value === undefined || value === "" ? null
        : h("div", { className: "ps-wf-fact", key: label, title: title ?? undefined }, h("span", null, label), h("strong", null, value));
    const summary = workflowNodeSummary(node, { execution: null });
    const input = node.input !== undefined ? JSON.stringify(node.input) : node.forEach ? (typeof node.forEach === "string" ? node.forEach : "its list") : null;
    return h("section", { className: "ps-wf-def-node", "aria-label": "Node" },
        h("p", { className: "ps-wf-node-head" }, h("strong", null, node.id), ` · ${node.typeWord ?? node.label ?? node.type}`),
        summary.what ? h("p", { className: "ps-wf-what", "data-node-what": "true" }, summary.what) : null,
        h("div", { className: "ps-wf-facts" },
            row("Input", input),
            row("Limit", Number.isFinite(node.timeoutSeconds) ? formatSeconds(node.timeoutSeconds) : null, "Time limit"),
            summary.agent ? row("Chat", summary.agent.chatMode) : null,
            summary.agent ? row("Tools", summary.agent.tools, summary.agent.toolsTitle) : null),
        summary.agent?.told ? h("details", { className: "ps-wf-told" }, h("summary", null, "Prompt"), h("pre", null, summary.agent.told))
            : summary.agent?.toldWords ? h("p", { className: "ps-wf-muted" }, summary.agent.toldWords) : null,
        // OF-S2-8 (owner, 2026-11-07T23:12Z): the script and sample input and output, each closed until opened.
        h(NodeCodeSections, { node, yaml, pending, hidden }),
        summary.next.lines.length || summary.next.failure ? h("div", { className: "ps-wf-next", "aria-label": "Next" },
            h("h3", null, "Next"),
            h("ul", null, summary.next.lines.map(line => h("li", { key: line.label, "data-route": line.label }, line.text))),
            summary.next.failure ? h("p", { className: "ps-wf-muted" }, summary.next.failure) : null) : null);
}

/** How far one arrow key moves the bottom panel's edge, and Shift or Page Up/Down. */
const PANEL_STEP = 16;
const PANEL_BIG_STEP = 64;
/** What stays above the bottom panel: the graph's minimum (L5) and the bars over it. */
const PANEL_ROOM_ABOVE = 190;

/**
 * The bottom panel (L5): one panel at a time, closed by default; a phone shows it as a sheet with a way back (12). Open,
 * it keeps ONE height whatever tab shows (owner feedback 2026-11-06: no jumping between Node, Log and Variables), and
 * its contents scroll inside. Its top edge is a handle: drag it, or focus it and use the arrow keys (Shift or Page
 * Up/Down for bigger steps, Home and End for the smallest and largest); a double-click puts the default back. The
 * height is remembered per device class in the profile settings (workflowPanelHeights). With `side` (OF-S2-1: a desktop
 * in full screen or zen, workflowPanelIsSide), the same panel is a column to the right of the graph instead (SidePanel).
 */
export function BottomPanel({ controller, panels, panel, onPanel, mobile, children, extra = null, side = false }) {
    if (side && !mobile) return h(SidePanel, { controller, panels, panel, onPanel, extra }, children);
    return h(UnderPanel, { controller, panels, panel, onPanel, mobile, extra }, children);
}

/** The panel's tab buttons: one per panel; a second click on the shown one closes it (not on a phone, whose sheet has Back). */
function PanelTabs({ panels, panel, onPanel, mobile = false, vertical = false }) {
    const labels = { node: "Node", log: "Log", variables: "Variables", revisions: "Revisions", test: "Test" };
    return h("div", { className: "ps-wf-panel-tabs", role: "tablist", "aria-label": "Workflow panel", ...(vertical ? { "aria-orientation": "vertical" } : {}) },
        panels.map(id => h("button", { key: id, type: "button", role: "tab", "aria-selected": panel === id, className: panel === id ? "is-on" : "",
            onClick: () => onPanel(panel === id && !mobile ? null : id) }, labels[id])));
}

/** The bottom panel, as it was (normal mode, and a phone's sheet). */
function UnderPanel({ controller, panels, panel, onPanel, mobile, children, extra = null }) {
    const sheetRef = React.useRef(null);
    const device = mobile ? "phone" : "desktop";
    const stored = useControllerSelector(controller, state => state.ui.workflowPanelHeights?.[device] ?? null);
    const [dragHeight, setDragHeight] = React.useState(null);
    const [room, setRoom] = React.useState(Infinity);
    // The panel's container height bounds it: the graph keeps its minimum above it.
    React.useEffect(() => {
        const box = sheetRef.current?.parentElement;
        if (!box) return undefined;
        const measure = () => {
            const height = box.getBoundingClientRect().height;
            if (height > 0) setRoom(current => (current === height - PANEL_ROOM_ABOVE ? current : Math.max(WORKFLOW_PANEL_HEIGHT_MIN, height - PANEL_ROOM_ABOVE)));
        };
        measure();
        if (typeof ResizeObserver === "undefined") return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(box);
        return () => observer.disconnect();
    }, [Boolean(panel)]);
    const height = workflowPanelHeight({ [device]: dragHeight ?? stored ?? undefined }, device, room);
    const keep = next => controller.dispatch({ type: "ui/workflowPanelHeight", device,
        height: next === null ? null : workflowPanelHeight({ [device]: next }, device, room) });
    // The phone's Back gesture closes the sheet first (12): the sheet adds one history entry while it is open.
    React.useEffect(() => {
        if (!mobile || !panel || typeof window === "undefined") return undefined;
        let closedByBack = false;
        const entry = { psWorkflowSheet: true };
        window.history.pushState(entry, "");
        const onPop = () => { closedByBack = true; onPanel(null); };
        window.addEventListener("popstate", onPop);
        return () => {
            window.removeEventListener("popstate", onPop);
            if (!closedByBack && window.history.state?.psWorkflowSheet) window.history.back();
        };
    }, [mobile, Boolean(panel)]);
    const tabs = h(PanelTabs, { panels, panel, onPanel, mobile });
    if (!panel) return h("div", { ref: sheetRef, className: "ps-wf-panel is-closed" }, tabs, extra);
    const onPointerDown = event => {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = height;
        const target = event.currentTarget;
        target.setPointerCapture?.(event.pointerId);
        const move = next => setDragHeight(workflowPanelHeight({ [device]: startHeight - (next.clientY - startY) }, device, room));
        const up = next => {
            target.removeEventListener("pointermove", move);
            target.removeEventListener("pointerup", up);
            target.removeEventListener("pointercancel", up);
            keep(startHeight - (next.clientY - startY));
            setDragHeight(null);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
        target.addEventListener("pointercancel", up);
    };
    const onKeyDown = event => {
        const big = event.shiftKey ? PANEL_BIG_STEP : PANEL_STEP;
        const by = { ArrowUp: big, ArrowDown: -big, PageUp: PANEL_BIG_STEP, PageDown: -PANEL_BIG_STEP }[event.key];
        if (by !== undefined) { event.preventDefault(); keep(height + by); }
        else if (event.key === "Home") { event.preventDefault(); keep(WORKFLOW_PANEL_HEIGHT_MIN); }
        else if (event.key === "End") { event.preventDefault(); keep(Number.isFinite(room) ? room : height + PANEL_BIG_STEP * 4); }
    };
    return h("div", { ref: sheetRef, className: `ps-wf-panel${mobile ? " is-sheet" : ""}`, "data-panel": panel, style: { height: `${height}px` } },
        h("div", { className: "ps-wf-panel-resize", role: "separator", tabIndex: 0, "aria-orientation": "horizontal",
            "aria-label": "Resize the bottom panel", "aria-valuemin": WORKFLOW_PANEL_HEIGHT_MIN,
            "aria-valuemax": Number.isFinite(room) ? Math.round(room) : undefined, "aria-valuenow": Math.round(height),
            title: "Drag, or use the arrow keys, to resize. Double-click puts it back.",
            onPointerDown, onKeyDown, onDoubleClick: () => keep(null) }),
        h("div", { className: "ps-wf-panel-bar" },
            mobile ? h("button", { type: "button", className: "ps-mini-button ps-wf-back", onClick: () => onPanel(null) }, "← Graph") : null,
            tabs, extra,
            mobile ? null : h("button", { type: "button", className: "ps-wf-panel-close", "aria-label": "Close the panel", title: "Close", onClick: () => onPanel(null) }, "✕")),
        h("div", { className: "ps-wf-panel-body" }, children));
}

/** How far one arrow key moves the side panel's edge, and Shift or Page Up/Down. */
const SIDE_PANEL_STEP = 16;
const SIDE_PANEL_BIG_STEP = 64;

/**
 * Owner, 2026-11-07T16:29Z (OF-S2-1): in full screen and zen on a desktop, the panel is a column to the right of the graph
 * (WorkflowStage), with the same tabs, content and open state as the bottom panel, so a mode change keeps what was open.
 * Open, it keeps ONE width whatever tab shows, and its contents scroll inside. Its left edge is a handle: drag it, or focus
 * it and use the arrow keys (Left widens, Right narrows; Shift or Page Up/Down for bigger steps, Home and End for the
 * narrowest and widest); a double-click puts the default back. The graph keeps WORKFLOW_GRAPH_MIN_WIDTH to its left. The
 * width is remembered in the profile settings (workflowPanelWidths). Closed, it is a slim strip at the right edge with
 * the tabs stacked, so one click opens it.
 */
function SidePanel({ controller, panels, panel, onPanel, children, extra = null }) {
    const columnRef = React.useRef(null);
    const stored = useControllerSelector(controller, state => state.ui.workflowPanelWidths?.desktop ?? null);
    const [dragWidth, setDragWidth] = React.useState(null);
    const [room, setRoom] = React.useState(Infinity);
    // The split's width bounds it: the graph keeps its minimum to its left.
    React.useEffect(() => {
        const box = columnRef.current?.parentElement;
        if (!box) return undefined;
        const measure = () => {
            const width = box.getBoundingClientRect().width;
            if (width > 0) setRoom(current => (current === width - WORKFLOW_GRAPH_MIN_WIDTH ? current : Math.max(WORKFLOW_PANEL_WIDTH_MIN, width - WORKFLOW_GRAPH_MIN_WIDTH)));
        };
        measure();
        if (typeof ResizeObserver === "undefined") return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(box);
        return () => observer.disconnect();
    }, [Boolean(panel)]);
    const width = workflowPanelWidth({ desktop: dragWidth ?? stored ?? undefined }, room);
    const keep = next => controller.dispatch({ type: "ui/workflowPanelWidth", width: next === null ? null : workflowPanelWidth({ desktop: next }, room) });
    if (!panel) {
        return h("div", { ref: columnRef, className: "ps-wf-panel is-side is-closed" }, h(PanelTabs, { panels, panel, onPanel, vertical: true }), extra);
    }
    const onPointerDown = event => {
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        const target = event.currentTarget;
        target.setPointerCapture?.(event.pointerId);
        const move = next => setDragWidth(workflowPanelWidth({ desktop: startWidth - (next.clientX - startX) }, room));
        const up = next => {
            target.removeEventListener("pointermove", move);
            target.removeEventListener("pointerup", up);
            target.removeEventListener("pointercancel", up);
            keep(startWidth - (next.clientX - startX));
            setDragWidth(null);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
        target.addEventListener("pointercancel", up);
    };
    const onKeyDown = event => {
        const big = event.shiftKey ? SIDE_PANEL_BIG_STEP : SIDE_PANEL_STEP;
        const by = { ArrowLeft: big, ArrowRight: -big, PageUp: SIDE_PANEL_BIG_STEP, PageDown: -SIDE_PANEL_BIG_STEP }[event.key];
        if (by !== undefined) { event.preventDefault(); keep(width + by); }
        else if (event.key === "Home") { event.preventDefault(); keep(WORKFLOW_PANEL_WIDTH_MIN); }
        else if (event.key === "End") { event.preventDefault(); keep(Number.isFinite(room) ? room : width + SIDE_PANEL_BIG_STEP * 4); }
    };
    return h("div", { ref: columnRef, className: "ps-wf-panel is-side", "data-panel": panel, style: { width: `${width}px` } },
        h("div", { className: "ps-wf-panel-resize is-vertical", role: "separator", tabIndex: 0, "aria-orientation": "vertical",
            "aria-label": "Resize the side panel", "aria-valuemin": WORKFLOW_PANEL_WIDTH_MIN,
            "aria-valuemax": Number.isFinite(room) ? Math.round(room) : undefined, "aria-valuenow": Math.round(width),
            title: "Drag, or use the arrow keys, to resize. Double-click puts it back.",
            onPointerDown, onKeyDown, onDoubleClick: () => keep(null) }),
        h("div", { className: "ps-wf-panel-bar" },
            h(PanelTabs, { panels, panel, onPanel }), extra,
            h("button", { type: "button", className: "ps-wf-panel-close", "aria-label": "Close the panel", title: "Close", onClick: () => onPanel(null) }, "✕")),
        h("div", { className: "ps-wf-panel-body" }, children));
}

/**
 * The graph area and its panel (OF-S2-1). `side`: the panel is a column to the right of the graph, from below the header
 * bars to the bottom; the graph's own column keeps what goes with it (the YAML view, the replay timeline). Otherwise the
 * panel follows the graph, under it, exactly as before.
 */
export function WorkflowStage({ side, panel, children }) {
    // Spread, not passed as one list, so the graph's parts keep their places (and need no keys) as before.
    const parts = Array.isArray(children) ? children : [children];
    if (!side) return h(React.Fragment, null, ...parts, panel);
    return h("div", { className: "ps-wf-split", "data-panel-place": "side" }, h("div", { className: "ps-wf-split-graph" }, ...parts), panel);
}

/** The graph's display mode as it fits itself (F8): with a side panel, its opening and closing change the area too. */
export function workflowGraphMode(displayMode, side, panelOpen) {
    return side ? `${displayMode}${panelOpen ? ":panel" : ""}` : displayMode;
}

/** The Definition view (07). `definition.newestId` is the workflow child whose definition it shows. */
function DefinitionView({ controller, definition, tab, setTab, mobile, onStarted, ownerTitle = null, ownerWorking = false, displayMode = "normal",
    newestId = null, onShowNewest = null, versions = [], chosenVersion = null, gone = false }) {
    const child = useWorkflowChild(controller, definition.newestId);
    const { sessionId, session, view, workflowModel, places } = child;
    const projection = useDefinitionProjection(child);
    const graph = projection ? projection.definition : view.definition;
    const nodes = projection ? projection.nodes : child.legacyNodes;
    const selected = nodes.find(node => node.id === view.selectedNodeId) || nodes.find(node => node.id === graph?.initial) || nodes[0] || null;
    const runCommand = view.runCommand ?? null;
    const publication = React.useMemo(() => workflowV2DefinitionControls(workflowModel, runCommand), [workflowModel, runCommand]);
    const editor = React.useMemo(() => {
        const made = workflowV2DraftEditor(workflowModel, runCommand);
        return made ? { ...made, sessionId } : null;
    }, [workflowModel, runCommand, sessionId]);
    const startControl = definition.startable && publication
        ? publication.controls.find(control => control.operation === "publish_and_start" || control.operation === "start") ?? null : null;
    const [mode, setMode] = React.useState("graph");
    const [starting, setStarting] = React.useState(false);
    // Run again (W8): another Workflow from this definition. On the tested engine the chat starts it with the same YAML.
    const startedAlready = !definition.startable && definition.workflows.length > 0;
    const [asking, setAsking] = React.useState(false);
    // "Start…" from the Workflows list opens the Start form here once the definition's commands are read.
    React.useEffect(() => {
        if (!tab.start) return;
        if (startControl) {
            setTab({ start: false });
            if (startControl.enabled) setStarting(true);
        } else if (!definition.startable) setTab({ start: false });
    }, [tab.start, startControl?.enabled, definition.startable]);
    // "Start another…" from the Workflows list opens its form here.
    React.useEffect(() => {
        if (!tab.another) return;
        setTab({ another: false });
        if (startedAlready) setAsking(true);
    }, [tab.another, startedAlready]);
    // Test mode (spec 16): hidden unless the server lists a test operation for this workflow (PILOTSWARM_WORKFLOW_TEST_MODE=on).
    const testing = workflowV2TestModeListed(workflowModel);
    const panels = testing ? [...WORKFLOW_DEFINITION_PANELS, "test"] : WORKFLOW_DEFINITION_PANELS;
    const panel = panels.includes(tab.definitionPanel) ? tab.definitionPanel : null;
    // OF-S2-1: full screen and zen on a desktop put the panel beside the graph.
    const side = workflowPanelIsSide(displayMode, mobile);
    const select = id => {
        controller.dispatch({ type: "ui/workflowView", sessionId, view: { selectedNodeId: id } });
        // A desktop click opens the node's facts; a phone tap only selects, and a second tap opens them (12).
        if (!mobile || id === view.selectedNodeId) setTab({ definitionPanel: "node" });
    };
    const onPlaces = React.useCallback(steps => controller.dispatch({ type: "ui/workflowLayout", key: `session:${sessionId}`, steps, at: Date.now() }),
        [controller, sessionId]);
    const onGraphView = React.useCallback(graphView => controller.dispatch({ type: "ui/workflowView", sessionId, view: { graphView } }), [controller, sessionId]);
    const line = revisionLine(workflowModel, { writing: ownerWorking, writer: ownerTitle });
    const revision = Number.isSafeInteger(workflowModel?.revision?.revision) ? workflowModel.revision.revision : null;
    const notice = workflowV2RunCommandNotice(runCommand);
    const nextNumber = definition.workflows.length + 1;
    // F9 (owner, 2026-11-06T19:40Z): which definition this is: its version, and while it has not started, a draft (or not
    // started) and when it was made. A child not started that is not the newest says so, with the way to the newest.
    const facts = workflowChildDefinitionFacts(view);
    const headline = workflowDefinitionHeaderText({ revision, version: facts.version, state: facts.state, started: !definition.startable,
        made: session?.createdAt != null ? shownTime(session.createdAt) : null });
    const older = Boolean(newestId) && newestId !== sessionId;
    // OF-S2-8: the node's script and samples, from this definition's YAML (read when its panel shows a node).
    const nodeYaml = useWorkflowRevisionYaml(controller, sessionId, view, workflowModel, panel === "node" && selected?.shape === "v2");
    const nodeCode = { yaml: nodeYaml.yaml, pending: nodeYaml.pending, hidden: nodeYaml.hidden };
    return h("div", { className: "ps-wf-body" },
        h("div", { className: "ps-wf-bar" },
            h("span", { className: "ps-wf-bar-text", "data-definition-child": sessionId }, headline),
            older && onShowNewest ? h("button", { type: "button", className: "ps-link-button", "data-action": "show-newest", onClick: onShowNewest },
                "Not the newest: show the newest") : null,
            // Owner, 2026-11-06T13:43Z (F1): icons; each keeps its words as its name and explains itself in its tooltip.
            h("span", { className: "ps-wf-bar-actions" },
                startControl ? h(WorkflowToolButton, { label: "Start…", glyph: "start", "data-action": "start", disabled: !startControl.enabled,
                    title: startControl.enabled ? workflowTabButtonTip("start", { number: nextNumber }) : startControl.title,
                    onClick: () => setStarting(true) }) : null,
                startedAlready ? h(WorkflowToolButton, { label: "Start another…", glyph: "start-another", "data-action": "start-another",
                    title: workflowTabButtonTip("start-another", { name: definition.name, number: nextNumber }), onClick: () => setAsking(true) }) : null,
                h(WorkflowToolButton, { label: "YAML", glyph: "yaml", title: workflowTabButtonTip("yaml"), "aria-pressed": mode === "yaml",
                    onClick: () => setMode(mode === "yaml" ? "graph" : "yaml") }),
                h(WorkflowToolButton, { label: "Compare", glyph: "compare", title: workflowTabButtonTip("compare"), "aria-pressed": panel === "revisions",
                    onClick: () => setTab({ definitionPanel: panel === "revisions" ? null : "revisions" }) }))),
        // Review UI4-F1: the version chosen was deleted; the view shows the newest instead, and says so.
        gone ? h("p", { className: "ps-wf-line is-quiet", role: "status", "data-choice": "gone" }, "The version you chose was deleted. Showing the newest.")
            : null,
        line ? h("p", { className: `ps-wf-line ${line.calm ? "is-quiet" : "is-error"}`, role: "status", "data-drafting": line.calm ? "true" : undefined },
            line.text) : null,
        notice ? h(WorkflowV2RunCommandNotice, { controller, sessionId, notice }) : null,
        h(WorkflowStage, { side, panel: h(BottomPanel, { controller, panels, panel, mobile, side, onPanel: id => setTab({ definitionPanel: id }) },
            panel === "node" ? h(NodeFacts, { node: selected, ...nodeCode })
                : panel === "test" ? h(TestPanel, { controller, child, runCommand })
                : panel === "revisions"
                    // Owner, 2026-11-07T00:03Z: two versions of the name (each its own child in stage 1), and this version's
                    // revisions when it has more than one.
                    ? (versions.length >= 2 || (revision !== null && revision >= 2)
                        ? h(React.Fragment, null,
                            versions.length >= 2 ? h(WorkflowV2VersionCompare, { controller, versions, chosen: chosenVersion }) : null,
                            revision !== null && revision >= 2
                                ? h(WorkflowV2RevisionCompare, { controller, sessionId, latest: revision, reads: view.definitionRevisions ?? null }) : null)
                        : h("p", { className: "ps-wf-muted" }, revision === null ? "Loading…" : "1 version · 1 revision"))
                    : null) },
        h("div", { className: "ps-wf-main", hidden: mode !== "graph" || undefined },
            graph ? h(WorkflowGraph, { definition: graph, nodes, selected, select, scope: sessionId, viewport: view.graphView ?? null, onViewport: onGraphView,
                places: places ?? null, onPlaces, mobile, mode: workflowGraphMode(displayMode, side, Boolean(panel)) })
                // No graph to draw: the line above says why; its errors are listed under it (folded while the chat writes).
                : projection && line ? (line.calm
                    ? h("details", { className: "ps-wf-errors" }, h("summary", null, "Errors so far"), h(WorkflowV2Diagnostics, { diagnostics: projection.diagnostics }))
                    : h("div", { className: "ps-wf-errors" }, h(WorkflowV2Diagnostics, { diagnostics: projection.diagnostics })))
                : projection ? h(WorkflowV2NoGraph, { projection })
                : h("p", { className: "ps-wf-muted" }, view.error || "Loading the definition…")),
        mode === "yaml" ? h("div", { className: "ps-wf-main ps-wf-yaml" },
            editor ? h(WorkflowV2DraftEditor, { key: sessionId, controller, sessionId, model: editor, savedEdit: view.draftEdit ?? null })
                : h(WorkflowV2YamlView, { key: sessionId, controller, sessionId, model: workflowModel, reads: view.definitionRevisions ?? null })) : null),
        starting && startControl ? h(StartDialog, { controller, sessionId, publication, control: startControl, name: definition.name, number: nextNumber,
            onClose: () => setStarting(false), onStarted: () => { setStarting(false); onStarted(sessionId); } }) : null,
        // Review UI-13: Start another repeats the definition's newest Workflow, filled with its own inputs when the read has them.
        asking ? h(StartDialog, { controller, sessionId, name: definition.name, number: nextNumber,
            source: { number: definition.workflows.find(item => item.sessionId === definition.newestId)?.number ?? null,
                inputs: workflowV2RunInputs(workflowModel) },
            publication: { inputsSchema: publication?.inputsSchema ?? graphInputsSchema(workflowModel), revision, publishedRevision: revision,
                state: "published", valid: true },
            onAsk: ({ inputs, vars, noInputs }) => controller.startAnotherWorkflow(sessionId, { inputs, vars, noInputs }),
            onClose: () => setAsking(false), onStarted: () => setAsking(false) }) : null);
}

/** The inputs schema of a definition's graph, when its read model has one; null otherwise. */
function graphInputsSchema(model) {
    const schema = model?.graph?.inputsSchema;
    return schema && typeof schema === "object" && !Array.isArray(schema) ? schema : null;
}

/**
 * The Test panel of the Definition view: test mode (spec 16), shown only when the server lists a test operation for the
 * workflow (the deployment sets PILOTSWARM_WORKFLOW_TEST_MODE=on). It is the old screen's test review, its test runs
 * and, for the test run chosen, its held calls, its virtual clock and the answer form, from the same components. Test
 * runs are not Workflows: they show here only.
 */
function TestPanel({ controller, child, runCommand }) {
    const { sessionId, session, view, readModel, workflowModel, readError } = child;
    const controls = React.useMemo(() => workflowV2TestControls(readModel ?? workflowModel, runCommand), [readModel, workflowModel, runCommand]);
    const responder = React.useMemo(() => workflowV2TestResponder(readModel, runCommand), [readModel, runCommand]);
    const run = readModel?.run && readModel.run.mode === "test" ? readModel.run : null;
    const answering = view.answeringInterceptionId ?? null;
    return h("div", { className: "ps-wf-test", "data-panel": "test" },
        controls ? h(WorkflowV2TestPanel, { controller, sessionId, model: controls })
            : h("p", { className: "ps-wf-muted" }, workflowModel?.definition?.state === "published" ? WORKFLOW_V2_TEST_NEEDS_DRAFT_TEXT
                : "This workflow takes no test from people."),
        h(WorkflowV2RunPicker, { controller, sessionId, workflowModel, selectedRunId: view.selectedRunId ?? null, ownModelLoaded: readModel != null,
            error: readError }),
        run?.test ? h("div", { className: "ps-workflow-test-calls" },
            h(WorkflowV2TestInterceptions, { test: run.test, controller, sessionId, responder, answering, history: run.history ?? null,
                onLoadOlder: restart => controller.loadOlderWorkflowHistory(sessionId, { restart }), parentSessionId: session?.parentSessionId ?? null }),
            responder?.advance ? h(WorkflowV2TestClock, { controller, sessionId, responder }) : null,
            responder?.respond && answering
                ? h(WorkflowV2TestAnswer, { controller, sessionId, responder, interceptionId: answering, parentSessionId: session?.parentSessionId ?? null })
                : null) : null);
}

/** The Workflows list (08, W1): one row per Workflow of the definition, newest first. */
function WorkflowList({ controller, definition, byId, views, onOpen, onStart, onAnother, onShowChild = null }) {
    const rows = [...definition.workflows].reverse();
    // F9 (owner, 2026-11-06T19:40Z): the definition's children that have not started (a chat's new draft is one), newest
    // first: one line says so; each opens in the Definition view with its version and when it was made.
    const unstarted = workflowUnstartedChildren(byId, definition, views);
    const unstartedLine = rows.length || unstarted.length > 1 ? workflowUnstartedLine(unstarted) : null;
    // Review UI4-F4: two that would read alike (the same version, made in the same second) say their numbers.
    const numbers = workflowMadeNumbers(unstarted, item => (item.createdAt != null ? shownTime(item.createdAt) : null));
    const itemWords = item => [item.version ?? null, item.state === "draft" ? "draft" : "not started",
        workflowMadeWords(item.createdAt != null ? shownTime(item.createdAt) : null, numbers.get(item.sessionId) ?? null)].filter(Boolean).join(" · ");
    const ids = rows.map(row => row.sessionId);
    const histories = useControllerSelector(controller, state => state.history.bySessionId);
    const stamp = rows.map(row => `${row.sessionId}:${byId?.[row.sessionId]?.updatedAt ?? ""}`).join(",");
    // The newest Workflows' states, revisions and times come from their read models and events.
    React.useEffect(() => {
        for (const id of ids.slice(0, LIST_READ_LIMIT)) {
            controller.ensureSessionHistory(id).catch(() => {});
            controller.ensureWorkflowReadModel(id).catch(() => {});
        }
    }, [controller, stamp]);
    return h("div", { className: "ps-wf-body" },
        unstartedLine ? h("div", { className: "ps-wf-unstarted", role: "status", "data-count": unstarted.length },
            h("p", { className: "ps-wf-line" }, unstartedLine,
                unstarted.length === 1 && onShowChild ? h(React.Fragment, null, " ",
                    h("button", { type: "button", className: "ps-link-button", "data-action": "show-unstarted",
                        onClick: () => onShowChild(unstarted[0].sessionId) }, "Show it"), " ",
                    h("button", { type: "button", className: "ps-link-button", "data-action": "start-unstarted",
                        onClick: () => onShowChild(unstarted[0].sessionId, { start: true }) }, "Start…")) : null),
            unstarted.length > 1 ? h("ul", { className: "ps-wf-unstarted-list", "aria-label": "Not started" },
                unstarted.map(item => h("li", { key: item.sessionId, "data-session-id": item.sessionId },
                    h("span", null, itemWords(item)), " ",
                    onShowChild ? h("button", { type: "button", className: "ps-link-button", "data-action": "show-unstarted",
                        "aria-label": `Show ${itemWords(item)}`, onClick: () => onShowChild(item.sessionId) }, "Show it") : null))) : null) : null,
        rows.length === 0
            ? h("div", { className: "ps-wf-empty" }, h("p", null, "No Workflows yet."), definition.startable
                ? h("button", { type: "button", className: "ps-mini-button is-primary", onClick: onStart }, "Start…") : null)
            : h("div", { className: "ps-wf-list", role: "table", "aria-label": `Workflows of ${definition.name}` },
                h("div", { className: "ps-wf-list-row is-head", role: "row" },
                    ["#", "State", "Version", "Started", "Took"].map(label => h("span", { key: label, role: "columnheader" }, label))),
                rows.map(row => {
                    const session = byId?.[row.sessionId] ?? null;
                    const view = views?.[row.sessionId] ?? null;
                    const state = workflowStateOf(session, view);
                    const model = workflowChildModel(view);
                    const live = Array.isArray(model?.runs) ? model.runs.find(run => run?.mode === "live") ?? null : null;
                    const times = workflowRunTimes(histories?.get?.(row.sessionId)?.events, live?.runId ?? null);
                    const reason = state?.key === "failed" && model?.run && model.run.mode !== "test" ? workflowFailure(model.run)?.reason ?? null : null;
                    // Review UI-16: a real row with cells; its action is a named button in its first cell (a click anywhere on
                    // the row does the same).
                    return h("div", { key: row.sessionId, role: "row", className: "ps-wf-list-row is-action", "data-session-id": row.sessionId,
                        onClick: event => { if (!event.target.closest?.("button")) onOpen(row.sessionId); } },
                        h("span", { role: "cell", className: "ps-wf-list-number" },
                            h("button", { type: "button", className: "ps-link-button", "aria-label": `Open ${definition.name} #${row.number}`,
                                onClick: () => onOpen(row.sessionId) }, `#${row.number}`)),
                        h("span", { role: "cell", className: "ps-wf-list-state" }, h(StateChip, { state }),
                            reason ? h("span", { className: "ps-wf-list-reason" }, reason) : null),
                        // Owner, 2026-11-07T00:03Z: every Workflow says its version (and its revision when past 1).
                        h("span", { role: "cell", className: "ps-wf-list-version" }, workflowListVersionText({ revision: live?.revision ?? null,
                            version: workflowChildDefinitionFacts(view).version })),
                        h("span", { role: "cell", className: "ps-wf-list-started" }, times.started !== null ? shownTime(times.started) : "—"),
                        h("span", { role: "cell", className: "ps-wf-list-took" }, times.took !== null ? workflowElapsedText(times.took) : "—"));
                })),
        rows.length ? h("div", { className: "ps-wf-bar is-foot" },
            definition.startable
                ? h(WorkflowToolButton, { label: "Start…", glyph: "start", "data-action": "start",
                    title: workflowTabButtonTip("start", { number: rows.length + 1 }), onClick: onStart })
                // Run again (W8): another Workflow from this definition, which the chat starts with the same YAML.
                : h(WorkflowToolButton, { label: "Start another…", glyph: "start-another", "data-action": "start-another",
                    title: workflowTabButtonTip("start-another", { name: definition.name, number: rows.length + 1 }), onClick: onAnother })) : null);
}

/** One Workflow (08): its header, controls by state, its failure first, its graph and its bottom panel. */
export function WorkflowRunView({ controller, definition, workflow, tab, setTab, mobile, phone = false, onOpen, nodeStateId = null, displayMode = "normal",
    chatRevision = null, extraActions = null }) {
    const child = useWorkflowChild(controller, workflow.sessionId);
    const { sessionId, session, view, places, events, projection, readModel, readError } = child;
    // Live while it is shown, also when its session's chat is the active session (the companion subscription).
    React.useEffect(() => controller.watchWorkflow(sessionId), [controller, sessionId]);
    // A Workflow is its live run: a test run chosen in the Definition view's Test panel (test mode) is not shown here.
    React.useEffect(() => {
        if (view.selectedRunId) controller.dispatch({ type: "ui/workflowView", sessionId, view: { selectedRunId: null } });
    }, [controller, sessionId, view.selectedRunId]);
    // Stage 2.4 (FU-26, the replay): under the graph of a finished Workflow, a timeline of its loaded visits (a running one
    // is shown live). `replayId` is the visit shown (the graph as it stood when that visit began), or null for the Workflow
    // as it is now. It is kept by visit, not by position, so older visits loaded later do not move it.
    const frames = React.useMemo(() => workflowV2ReplayFrames(projection?.allExecutions), [projection?.allExecutions]);
    const [replayId, setReplayId] = React.useState(null);
    const [playing, setPlaying] = React.useState(false);
    React.useEffect(() => { setReplayId(null); setPlaying(false); }, [sessionId]);
    const replayable = projection?.status?.ended === true && frames.length >= 2;
    const replayIndex = replayId === null || !replayable ? null : frames.findIndex(frame => frame.nodeExecutionId === replayId);
    const frame = replayIndex !== null && replayIndex >= 0 ? frames[replayIndex] : null;
    const frameAt = frame ? frame.atMs : null;
    const replayed = React.useMemo(() => frameAt !== null ? child.projectAt(frameAt) : null, [frameAt, child.projectAt]);
    const goTo = index => {
        const next = index !== null && index >= 0 && index < frames.length ? frames[index] : null;
        setReplayId(next ? next.nodeExecutionId : null);
        // The visit shown is the node selected (its panel says it as it stood then).
        if (next) controller.dispatch({ type: "ui/workflowView", sessionId, view: { selectedNodeId: next.stateId } });
    };
    // Playing shows each next visit in turn and stops at the last one.
    React.useEffect(() => {
        if (!playing) return undefined;
        if (frame === null || replayIndex >= frames.length - 1) { setPlaying(false); return undefined; }
        const timer = setTimeout(() => goTo(replayIndex + 1), REPLAY_STEP_MS);
        return () => clearTimeout(timer);
    }, [playing, replayId, frames.length]);
    const replay = replayable ? {
        frames, index: frame ? replayIndex : null, playing,
        onGo: index => { setPlaying(false); goTo(index); },
        onPlay: () => { if (frame === null || replayIndex >= frames.length - 1) goTo(0); setPlaying(true); },
        onPause: () => setPlaying(false),
        onOlder: projection && !projection.historyComplete && typeof controller.loadOlderWorkflowHistory === "function"
            ? () => { controller.loadOlderWorkflowHistory(sessionId, { restart: Boolean(projection.historyStale) }).catch(() => {}); } : null,
    } : null;
    const logReplay = React.useMemo(() => replay ? {
        visits: new Set(frames.map(item => item.nodeExecutionId)), current: frame?.nodeExecutionId ?? null,
        onVisit: id => { const index = frames.findIndex(item => item.nodeExecutionId === id); if (index >= 0) { setPlaying(false); goTo(index); } },
        // Review S2UI-F7: the Workflow's older events, read while a replayed visit's line is older than the loaded ones.
        older: { more: child.olderEvents, load: typeof controller.expandSessionHistory === "function" ? () => controller.expandSessionHistory(sessionId) : null },
    } : null, [Boolean(replay), frames, frame?.nodeExecutionId, child.olderEvents, controller, sessionId]);
    const nodes = replayed ? replayed.nodes : child.nodes;
    const graph = child.definition;
    const chosen = nodeStateId && view.selectedNodeId == null ? nodeStateId : view.selectedNodeId;
    const selected = nodes.find(node => node.id === chosen) || (projection ? nodes.find(node => node.pending) : null)
        || nodes.find(node => node.id === graph?.initial) || nodes[0] || null;
    const state = workflowStateOf(session, view);
    const runCommand = view.runCommand ?? null;
    const runControls = React.useMemo(() => workflowV2RunControls(readModel, runCommand), [readModel, runCommand]);
    const variables = React.useMemo(() => workflowV2RunVariables(readModel, runCommand), [readModel, runCommand]);
    const notice = workflowV2RunCommandNotice(runCommand);
    const runId = projection?.runId ?? readModel?.run?.runId ?? null;
    const times = workflowRunTimes(events, runId);
    // Stage 2.1b: a Workflow of a chat's definition says the definition's revision it runs (its own copy is revision 1).
    const revision = Number.isSafeInteger(chatRevision) ? chatRevision
        : Number.isSafeInteger(projection?.readModel?.runRevision) ? projection.readModel.runRevision : null;
    // F6: a failed terminal's summary, from the run's end event, for a run whose failure route ended it with no error of its own.
    const endSummary = React.useMemo(() => {
        for (let at = events.length - 1; at >= 0; at -= 1) {
            const event = events[at];
            if (event?.eventType === "workflow.failed" && (!runId || event.data?.runId === runId)) return typeof event.data?.summary === "string" ? event.data.summary : null;
        }
        return null;
    }, [events, runId]);
    const failure = state?.key === "failed" && readModel?.run && readModel.run.mode !== "test" ? workflowFailure(readModel.run, { summary: endSummary }) : null;
    const [stopping, setStopping] = React.useState(false);
    // r3 (390 px): a phone shows the failure on one line beside Details; a tap on it shows all of it.
    const [failureOpen, setFailureOpen] = React.useState(false);
    // An agent node's Log shows its chat (finding 8); "Whole Workflow" shows every line of this Workflow.
    const [logScope, setLogScope] = React.useState("node");
    const controls = runControls?.controls ?? [];
    const has = operation => controls.find(control => control.operation === operation) ?? null;
    const pause = has("pause"), resume = has("resume"), stop = has("stop"), cancel = has("cancel");
    const panel = WORKFLOW_RUN_PANELS.includes(tab.runPanel) ? tab.runPanel : null;
    // OF-S2-1: full screen and zen on a desktop put the panel beside the graph.
    const side = workflowPanelIsSide(displayMode, mobile);
    const select = (id, { open = false } = {}) => {
        controller.dispatch({ type: "ui/workflowView", sessionId, view: { selectedNodeId: id } });
        // A tap selects; a second tap on the selected node, or a desktop click, opens its details (12).
        if (open || !mobile || id === view.selectedNodeId) setTab({ runPanel: "node" });
    };
    const onPlaces = React.useCallback(steps => controller.dispatch({ type: "ui/workflowLayout", key: `session:${sessionId}`, steps, at: Date.now() }),
        [controller, sessionId]);
    const onGraphView = React.useCallback(graphView => controller.dispatch({ type: "ui/workflowView", sessionId, view: { graphView } }), [controller, sessionId]);
    const number = workflow.number;
    const started = times.started !== null ? shownTime(times.started) : null;
    const took = times.took !== null ? workflowElapsedText(times.took) : null;
    // Its words in full, for the header's tooltip: the start with its date and zone, and how long it ran.
    const headerTitle = [revision !== null ? `revision ${revision}` : null, times.started !== null ? `started ${shownTimeTitle(times.started)}` : null,
        took ? `ran ${took}` : null].filter(Boolean).join(" · ");
    return h("div", { className: "ps-wf-body", "data-session-id": sessionId },
        h("div", { className: "ps-wf-bar is-run" },
            h(WorkflowNumberPicker, { controller, definition, chosen: sessionId, onOpen, phone }),
            // A phone's second header row: the time taken joins the state ("Running · 2:45"); its start and revision move to
            // the state's tooltip and the picker's options (owner, 2026-11-06T13:43Z: relocated, not removed).
            phone
                ? h(StateChip, { state, time: took,
                    title: [started ? `Started ${started}` : null, revision !== null ? `revision ${revision}` : null].filter(Boolean).join(" · ") })
                : h(StateChip, { state }),
            phone ? null : h("span", { className: "ps-wf-bar-text", title: headerTitle || undefined },
                [revision !== null ? `revision ${revision}` : null, started, took].filter(Boolean).join(" · ")),
            // Owner, 2026-11-06T13:43Z (F1): icons; a refused or waiting control explains why in its tooltip.
            h("span", { className: "ps-wf-bar-actions" },
                pause ? h(WorkflowToolButton, { label: pause.label, glyph: "pause", "data-operation": "pause", disabled: !pause.enabled,
                    title: pause.enabled ? workflowTabButtonTip("pause") : pause.title,
                    onClick: () => controller.sendWorkflowRunCommand(sessionId, { operation: "pause", runId: runControls.runId }) }) : null,
                resume ? h(WorkflowToolButton, { label: resume.label, glyph: "resume", "data-operation": "resume", disabled: !resume.enabled,
                    title: resume.enabled ? workflowTabButtonTip("resume") : resume.title,
                    onClick: () => controller.sendWorkflowRunCommand(sessionId, { operation: "resume", runId: runControls.runId }) }) : null,
                stop || cancel ? h(WorkflowToolButton, { label: "Stop…", glyph: "stop", "data-action": "stop-dialog",
                    disabled: !(stop?.enabled || cancel?.enabled),
                    title: stop?.enabled || cancel?.enabled ? workflowTabButtonTip("stop") : (stop?.title ?? cancel?.title ?? null),
                    onClick: () => setStopping(true) }) : null,
                extraActions)),
        // Failure first, in plain words; the error as it arrived is folded under it (coordinator 2026-11-06).
        failure ? h("div", { className: `ps-wf-failure${phone && failureOpen ? " is-open" : ""}` },
            // On a phone the line is a button (Enter and Space too) that shows all of it; the status still reads it whole.
            h("p", { className: "ps-wf-line is-error", role: "status" },
                phone ? h("button", { type: "button", className: "ps-wf-failure-toggle", "aria-expanded": failureOpen, title: failure.headline,
                    onClick: () => setFailureOpen(open => !open) }, failure.headline) : failure.headline),
            h(WorkflowV2FailureDetails, { failure, runId, executionValues: view.executionValues ?? null,
                onReadWholeValue: executionId => { controller.loadWorkflowExecutionValue(sessionId, { runId, executionId }).catch(() => {}); } })) : null,
        readError ? h("p", { className: "ps-wf-line is-error", role: "alert" }, `This Workflow could not be read: ${readError} `,
            h("button", { type: "button", className: "ps-mini-button", onClick: () => controller.ensureWorkflowReadModel(sessionId, { force: true }) }, "Retry")) : null,
        notice ? h(WorkflowV2RunCommandNotice, { controller, sessionId, notice }) : null,
        h(WorkflowStage, { side, panel: h(BottomPanel, { controller, panels: variables ? WORKFLOW_RUN_PANELS : WORKFLOW_RUN_PANELS.filter(id => id !== "variables"),
            panel, mobile, side, onPanel: id => setTab({ runPanel: id }) },
            panel === "node" ? h(RunNodePanel, { controller, child: replayed ? { ...child, nodes } : child, selected, replayFrame: replayed ? frame : null,
                onLog: () => { setLogScope("node"); setTab({ runPanel: "log" }); } }) : null,
            panel === "log" ? h(RunLogPanel, { controller, workflowSessionId: sessionId, events, runId,
                runs: Array.isArray(readModel?.runs) ? readModel.runs : null, selected, scope: logScope, onScope: setLogScope,
                instructionsReadable: workflowBaseInstructionsReadable(readModel), replay: logReplay }) : null,
            panel === "variables" ? (variables ? h(WorkflowV2Variables, { controller, sessionId, model: variables }) : h("p", { className: "ps-wf-muted" }, "No variables."))
                : null) },
        h("div", { className: "ps-wf-main" },
            graph ? h(WorkflowGraph, { definition: graph, nodes, selected, select, scope: sessionId, viewport: view.graphView ?? null, onViewport: onGraphView,
                places: places ?? null, onPlaces, mobile, mode: workflowGraphMode(displayMode, side, Boolean(panel)) })
                : projection ? h(WorkflowV2NoGraph, { projection })
                : h("p", { className: "ps-wf-muted" }, view.error || "Loading the Workflow…")),
        // The replay timeline stays with the graph (OF-S2-1).
        graph && replay ? h(ReplayBar, replay) : null),
        stopping ? h(StopDialog, { controller, sessionId, runId: runControls?.runId ?? runId, title: `${definition.name} #${number}`, stop, cancel,
            onClose: () => setStopping(false) }) : null);
}

/**
 * Stage 2.4 (FU-26, the replay): under the graph, Step back, Play or Pause, Step on, a slider over the run's loaded
 * visits with "Now" at its end, the moment shown in words, Back to now, and Load older visits while older visits are not
 * loaded. The graph above shows each node as it stood when the chosen visit began; the Log's line for that visit is
 * marked, and a click on a visit's line in the Log moves the replay to it.
 */
function ReplayBar({ frames, index, playing, onGo, onPlay, onPause, onOlder = null }) {
    const id = `wf-replay-${React.useId().replace(/:/g, "")}`;
    const now = frames.length;
    const position = index ?? now;
    const words = index !== null ? workflowV2ReplayLabel(frames[index]) : "Now";
    return h("div", { className: "ps-wf-replay", role: "group", "aria-label": "Replay", "data-replaying": index !== null ? "true" : "false" },
        h(WorkflowToolButton, { label: "Step back", glyph: "step-back", "data-action": "replay-back", disabled: position <= 0,
            title: "Show the visit before", onClick: () => onGo(position - 1) }),
        playing
            ? h(WorkflowToolButton, { label: "Pause the replay", glyph: "pause", "data-action": "replay-pause", onClick: onPause })
            : h(WorkflowToolButton, { label: "Play the replay", glyph: "resume", "data-action": "replay-play",
                title: "Show each visit in turn, from the first", onClick: onPlay }),
        h(WorkflowToolButton, { label: "Step on", glyph: "step-on", "data-action": "replay-on", disabled: position >= now,
            title: "Show the next visit", onClick: () => onGo(position + 1 >= now ? null : position + 1) }),
        h("label", { htmlFor: id, className: "ps-sr-only" }, "Replay position"),
        h("input", { id, type: "range", className: "ps-wf-replay-range", min: 0, max: now, step: 1, value: position, "aria-valuetext": words,
            onChange: event => { const next = Number(event.target.value); onGo(next >= now ? null : next); } }),
        h("span", { className: "ps-wf-replay-label", title: index !== null ? workflowTimeTitle(frames[index].atMs) ?? undefined : undefined }, words),
        index !== null ? h("button", { type: "button", className: "ps-mini-button", "data-action": "replay-now", onClick: () => onGo(null) }, "Back to now") : null,
        onOlder ? h("button", { type: "button", className: "ps-mini-button", "data-action": "replay-older", onClick: onOlder }, "Load older visits") : null);
}

/**
 * "#7 of 7 ▾" (W3; owner, 2026-11-06T13:43Z, F2: the count is in this picker, not beside the definition): the definition's
 * Workflows, newest first, in one group that says how many ("7 Workflows"), each "#7 · Running · 05:38:01", then the list
 * of all of them. The closed picker is a face over the native select (the native list still opens, on a phone too); the
 * select keeps the name "Workflow" and its value. The newest Workflows' states and starts come from their read models
 * and events, read as the Workflows list reads them (the shown one by its own view).
 */
function WorkflowNumberPicker({ controller, definition, chosen, onOpen, phone = false }) {
    const id = `wf-number-${React.useId().replace(/:/g, "")}`;
    const byId = useControllerSelector(controller, state => state.sessions.byId);
    const views = useControllerSelector(controller, state => state.ui.workflowViews);
    const histories = useControllerSelector(controller, state => state.history.bySessionId);
    const rows = [...definition.workflows].reverse();
    const stamp = rows.map(row => `${row.sessionId}:${byId?.[row.sessionId]?.updatedAt ?? ""}`).join(",");
    // The shown Workflow is read by its own view; a second ask while that read is in flight would read it once more.
    React.useEffect(() => {
        for (const row of rows.slice(0, LIST_READ_LIMIT)) {
            if (row.sessionId === chosen) continue;
            controller.ensureSessionHistory(row.sessionId).catch(() => {});
            controller.ensureWorkflowReadModel(row.sessionId).catch(() => {});
        }
    }, [controller, stamp, chosen]);
    const count = rows.length;
    const shown = rows.find(row => row.sessionId === chosen) ?? null;
    const label = row => {
        const view = views?.[row.sessionId] ?? null;
        const model = workflowChildModel(view);
        const live = Array.isArray(model?.runs) ? model.runs.find(run => run?.mode === "live") ?? null : null;
        const times = workflowRunTimes(histories?.get?.(row.sessionId)?.events, live?.runId ?? null);
        return workflowPickerOptionLabel({ number: row.number, version: workflowChildDefinitionFacts(view).version,
            state: workflowStateOf(byId?.[row.sessionId], view)?.label ?? null,
            started: times.started !== null ? shownTime(times.started) : null, revision: phone ? live?.revision ?? null : null });
    };
    // OF-S2-8 (owner, 2026-11-07T23:19Z): the picker says what it picks, "Workflow", in words beside it.
    return h(FacedPicker, { id, label: "Workflow", kind: "is-number", face: shown ? workflowPickerFace(shown.number, count) : "—", value: chosen,
        onChange: event => onOpen(event.target.value === "__all__" ? null : event.target.value) },
        h("optgroup", { label: workflowPickerGroupLabel(count) },
            rows.map(row => h("option", { key: row.sessionId, value: row.sessionId }, label(row)))),
        h("option", { value: "__all__" }, "All Workflows"));
}

/**
 * OF-S2-8 (owner, 2026-11-07T23:18Z): a picker with its name in words before it ("Definition", "Rev", "Workflow"; a real
 * label for it) and a short face: the face is drawn, the native select lies over it, transparent, and takes the clicks
 * and taps, so its open list (a phone's too) keeps each option's detail while the closed picker stays short.
 * `ariaLabel`: a fuller name when the words shown are short ("Rev": "Revision"); `faceTitle`: the face's tooltip.
 */
export function FacedPicker({ id, label, labelTitle = null, ariaLabel = null, kind = "", face, faceTitle = null, field = null, value, onChange, group = "",
    children }) {
    return h("span", { className: `ps-wf-picker-group${group ? ` ${group}` : ""}` },
        h("label", { htmlFor: id, className: "ps-wf-picker-label", title: labelTitle ?? undefined }, label),
        h("span", { className: `ps-wf-picker is-faced${kind ? ` ${kind}` : ""}` },
            h("span", { className: "ps-workflow-input ps-wf-picker-face", "aria-hidden": "true" }, h("span", { className: "ps-wf-picker-face-text" }, face)),
            h("select", { id, className: "ps-workflow-input ps-wf-picker-native", value, onChange, "data-field": field ?? undefined,
                "aria-label": ariaLabel ?? undefined, title: faceTitle ?? undefined }, children)));
}

/**
 * OF-S2-8: the YAML of the revision a workflow child shows (its published one, else its current one), read once when
 * `wanted` (kept in its view's definitionRevisions by the controller), for its Script and sample sections: { yaml, pending, hidden }. A person who may
 * read the Workflow but not change it is not given the YAML (hidden says so), as the YAML view does.
 */
export function useWorkflowRevisionYaml(controller, sessionId, view, model, wanted = true) {
    const definition = model && typeof model.definition === "object" ? model.definition : null;
    const revision = definition?.state === "published" ? definition.publishedRevision : definition?.currentRevision;
    const known = Number.isSafeInteger(revision) && revision >= 1;
    const denied = model?.personCommands?.viewer?.allowed === false;
    const entry = known ? view?.definitionRevisions?.[revision] ?? null : null;
    React.useEffect(() => {
        if (wanted && known && !denied && !entry) controller?.loadWorkflowDefinitionRevision?.(sessionId, revision)?.catch?.(() => {});
    }, [controller, sessionId, revision, known, denied, wanted, Boolean(entry)]);
    const yaml = typeof entry?.value?.definitionRevision?.yaml === "string" ? entry.value.definitionRevision.yaml : null;
    return {
        yaml,
        pending: !denied && yaml === null && entry?.phase !== "failed" && known,
        hidden: denied ? "The script is shown to people who can change this workflow."
            : entry?.phase === "failed" ? `The script could not be read: ${entry.error ?? "no reason given"}` : null,
    };
}

/**
 * The Node panel of a Workflow (W10; owner feedback 2026-11-06, finding 7): one view that says what the node does, where
 * it is now, how often it ran, its last result, an agent node's chat and what its agent is told, and where each outcome
 * goes (WorkflowV2NodeSummary). No Details / Output / History tabs inside the panel's tab: the Log has the visits.
 */
export function RunNodePanel({ controller, child, selected, onLog = null, replayFrame = null }) {
    const { sessionId, view, projection } = child;
    // OF-S2-8: the script and samples come from the YAML of the revision this Workflow runs, read once, when allowed.
    const code = useWorkflowRevisionYaml(controller, sessionId, view, child.workflowModel ?? child.readModel ?? null, selected?.shape === "v2");
    const [branchPick, setBranchPick] = React.useState(null);
    // Review S2UI-F5: while a visit is replayed, its step's details show that visit's branch. A branch chosen then holds
    // until the replay moves; the branch chosen for the Workflow as it is now is kept apart.
    const [replayPick, setReplayPick] = React.useState(null);
    const replayVisit = replayFrame?.nodeExecutionId ?? null;
    React.useEffect(() => { setReplayPick(null); }, [replayVisit]);
    if (!selected) return h("p", { className: "ps-wf-muted" }, "Select a node to see it.");
    if (selected.shape !== "v2") return h(LegacyNodePanel, { selected });
    const runId = projection?.runId ?? null;
    const pickKey = workflowV2BranchPickKey(sessionId, runId, selected);
    const replayKey = replayFrame ? JSON.stringify([replayFrame.nodeExecutionId, pickKey]) : null;
    const branchIndex = replayFrame
        ? (replayPick?.key === replayKey ? replayPick.index : workflowV2ReplayBranchIndex(selected, replayFrame))
        : (branchPick?.key === pickKey ? branchPick.index : null);
    return h("section", { className: "ps-wf-node", "aria-label": "Node details" },
        h("p", { className: "ps-wf-node-head" }, h("strong", null, selected.id), ` · ${selected.label}`),
        h(WorkflowV2NodeSummary, {
            selected, nodes: child.nodes, runId,
            // An agent node's visits, with its chat, are in its Log (finding 8).
            onLog: selected.kind === "agent" ? onLog : null,
            sections: h(NodeCodeSections, { node: selected, yaml: code.yaml, pending: code.pending, hidden: code.hidden }),
            select: id => controller.dispatch({ type: "ui/workflowView", sessionId, view: { selectedNodeId: id } }),
            openSession: id => { controller.loadSession(id).catch(() => {}); },
            executionValues: view.executionValues ?? null,
            onReadWholeValue: executionId => { controller.loadWorkflowExecutionValue(sessionId, { runId, executionId }).catch(() => {}); },
            branchIndex,
            onBranch: index => {
                if (replayFrame) setReplayPick({ key: replayKey, index });
                else setBranchPick({ key: pickKey, index });
                if (workflowV2SelectionAfterBranchChange(view.selectedExecution ?? null, selected.id) === null && view.selectedExecution) {
                    controller.selectWorkflowExecution(sessionId, null);
                }
            },
        }));
}

/**
 * The Node panel of a version 1 Workflow (its nodes come from its events): what the old step details showed, in the
 * Workflow tab's words. Every value is text, never markup.
 */
function LegacyNodePanel({ selected }) {
    const [detailTab, setDetailTab] = React.useState("details");
    const result = selected.result ?? null;
    const row = (label, value) => h("div", { className: "ps-wf-fact", key: label }, h("span", null, label), h("strong", null, String(value)));
    const tabs = [["details", "Details"], ["output", "Output"]];
    return h("section", { className: "ps-wf-node", "aria-label": "Node details", "data-shape": "v1" },
        // Review 21:15Z: its state in the Workflow's words ("Canceled", "Done · changed", "Not reached"), never the raw one.
        h("p", { className: "ps-wf-node-head" }, h("strong", null, selected.id),
            ` · ${selected.type === "terminal" ? "End" : "Script"} · ${workflowV1NodeWords(selected).state}`),
        h("div", { className: "ps-wf-node-tabs", role: "tablist", "aria-label": "Node detail views" },
            tabs.map(([id, title]) => h("button", { key: id, type: "button", role: "tab", "aria-selected": detailTab === id,
                className: detailTab === id ? "is-on" : "", onClick: () => setDetailTab(id) }, title))),
        detailTab === "details"
            ? h("div", { className: "ps-wf-facts" },
                row("Visits", workflowRunsText(selected.runs ?? 0, Boolean(selected.partial))),
                row("Outcome", selected.outcome || "Not recorded"),
                Object.keys(selected.next || {}).length
                    ? row("Next", Object.entries(selected.next).map(([outcome, target]) => `${outcome} → ${target}`).join(" · ")) : null,
                Array.isArray(result?.toolCalls) && result.toolCalls.length
                    ? row("Tools", result.toolCalls.map(tool => `${tool?.name || "Tool"}${tool?.ok === false ? " ✕" : ""}`).join(" · ")) : null)
            : h("div", { className: "ps-wf-node-output" },
                h("pre", null, result
                    ? String(result.error || result.reason || result.outputPreview || result.summary || "No output")
                    : "No result yet"),
                result?.stderrTail ? h(React.Fragment, null, h("h3", null, "Standard error"), h("pre", null, String(result.stderrTail))) : null));
}

/**
 * The Log panel (W10; finding 8). For an agent node: its own Log with its chat (AgentNodeLog), or, switched, the whole
 * Workflow's. For any other node: the whole Workflow's, as before.
 */
function RunLogPanel({ controller, workflowSessionId = null, events, runId, runs = null, selected, scope, onScope, instructionsReadable = true, replay = null }) {
    if (!(selected?.shape === "v2" && selected.kind === "agent")) return h(WorkflowLog, { events, runId, runs, replay });
    return h("div", { className: "ps-wf-log-panel" },
        h("div", { className: "ps-wf-switch is-log", role: "group", "aria-label": "Log of" },
            [["node", `Node ${selected.id}`], ["all", "Whole Workflow"]].map(([id, label]) => h("button", { key: id, type: "button",
                "aria-pressed": scope === id, className: scope === id ? "is-on" : "", onClick: () => onScope(id) }, label))),
        scope === "all" ? h(WorkflowLog, { events, runId, runs, replay }) : h(AgentNodeLog, { controller, workflowSessionId, node: selected, events, runId, instructionsReadable }));
}

/**
 * An agent node's Log (finding 8): its visits with its chat, read with the same history reads as any session. Each chat
 * of the shown visits is read once; while the newest visit works, its chat is read again every 5 s and at each new line
 * of the Workflow (a catch-up of the newer events only).
 */
function AgentNodeLog({ controller, workflowSessionId = null, node, events, runId, instructionsReadable = true }) {
    const [limit, setLimit] = React.useState(WORKFLOW_AGENT_LOG_VISITS);
    const chatIds = React.useMemo(() => workflowAgentLogChats(node, limit), [node, limit]);
    const chatKey = chatIds.join(",");
    const histories = useControllerSelector(controller, state => state.history.bySessionId);
    // r4 C04: each time the Log is shown it reads the lines its chats got since they were loaded (a forced read of a loaded
    // chat reads only the newer events): visits that ran while the Log was not shown are read too, not only a working one.
    React.useEffect(() => {
        for (const id of chatIds) controller.ensureSessionHistory(id, { force: true }).catch(() => {});
    }, [controller, chatKey]);
    const working = node.current?.status === "pending" ? node.current.agent?.childSessionId ?? null : null;
    const lines = Array.isArray(events) ? events.length : 0;
    React.useEffect(() => {
        if (!working) return undefined;
        const read = () => { controller.ensureSessionHistory(working, { force: true }).catch(() => {}); };
        read();
        const timer = setInterval(read, 5_000);
        return () => clearInterval(timer);
    }, [controller, working, lines]);
    const chats = React.useMemo(() => new Map(chatIds.map(id => [id, histories?.get?.(id)?.events])), [chatKey, histories]);
    const failed = React.useMemo(() => new Set(chatIds.filter(id => histories?.get?.(id)?.loadState === "failed")), [chatKey, histories]);
    // Review UI-10: each chat's coverage (older events exist), and Load older for one chat or the run's older visits.
    // Review UI-D6: at the history window's limit Load older makes no progress, so the Log says so; a failed older-page
    // read is kept and shown, with Retry.
    const [olderChatErrors, setOlderChatErrors] = React.useState(() => new Map());
    const coverage = React.useMemo(() => new Map(chatIds.map(id => {
        const history = histories?.get?.(id);
        const capped = history?.hasOlderEvents === true && Number(history?.loadedEventCount || 0) >= AUTO_HISTORY_EVENT_SOFT_CAP;
        return [id, { hasOlder: history?.hasOlderEvents === true, ...(capped ? { cap: AUTO_HISTORY_EVENT_SOFT_CAP } : {}),
            ...(olderChatErrors.has(id) ? { error: olderChatErrors.get(id) } : {}) }];
    })), [chatKey, histories, olderChatErrors]);
    const [olderChatLoading, setOlderChatLoading] = React.useState(() => new Set());
    const onOlderChat = chatId => {
        setOlderChatLoading(current => new Set([...current, chatId]));
        setOlderChatErrors(current => { if (!current.has(chatId)) return current; const next = new Map(current); next.delete(chatId); return next; });
        Promise.resolve(controller.expandSessionHistory(chatId))
            .catch(error => setOlderChatErrors(current => new Map(current).set(chatId, String(error?.message || error || "the read failed"))))
            .finally(() => setOlderChatLoading(current => { const next = new Set(current); next.delete(chatId); return next; }));
    };
    const onOlderVisits = workflowSessionId && typeof controller.loadOlderWorkflowHistory === "function"
        ? () => { controller.loadOlderWorkflowHistory(workflowSessionId).catch(() => {}); } : null;
    // OF-S2-7: each chat's model as its session row says it (what its visits used).
    const chatModelsKey = useControllerSelector(controller, state => JSON.stringify(chatIds.map(id => workflowSessionModelKey(state.sessions.byId, id))));
    const chatModels = React.useMemo(() => new Map(JSON.parse(chatModelsKey).map((key, index) => [chatIds[index], workflowModelFromKey(key)])), [chatModelsKey, chatKey]);
    const log = React.useMemo(() => workflowAgentNodeLog({ node, events, chats, coverage, runId, limit, chatModels }),
        [node, events, chats, coverage, runId, limit, chatModels]);
    // The base instructions are read like any file of a session (the Workflow's), when a person opens their row; only by
    // the Workflow's owner (review SF-3): anyone else sees the summary row and is told so. The text read is shown only
    // when its sha256 is the recorded one (review SF-4); opened again, it is read again.
    const files = useControllerSelector(controller, state => state.files.bySessionId);
    const readInstructions = ref => {
        if (!instructionsReadable) return { ownerOnly: true };
        if (!ref?.sessionId) return null;
        const preview = files?.[ref.sessionId]?.previews?.[ref.artifact];
        if (!preview) return null;
        const text = typeof preview.content === "string" && !preview.loading ? preview.content : null;
        if (text !== null && !workflowBaseInstructionsMatch(ref, text)) return { changed: true };
        return { loading: Boolean(preview.loading), text, error: preview.error ?? null };
    };
    const onInstructions = instructionsReadable
        ? ref => { controller.ensureFilePreview(ref.sessionId, ref.artifact, { force: true }).catch(() => {}); } : null;
    return h(WorkflowV2AgentLog, { log, failed, nodeId: node.id, readInstructions, onInstructions, onOlderChat, olderChatLoading, onOlderVisits,
        onMore: () => setLimit(limit + WORKFLOW_AGENT_LOG_VISITS), onOpenChat: id => { controller.loadSession(id).catch(() => {}); } });
}

/**
 * The Log panel (W10): this Workflow only, newest first, one sentence each. That is its live run's events and the
 * Workflow's own notices (no run id, such as a recovery request); a test run's events never show (test mode is hidden,
 * spec 16, and test runs are not Workflows): which runs are live is the server's word, its read model's runs
 * (workflowLogEvents; review SF-D5).
 */
export function WorkflowLog({ events, runId, runs = null, replay = null }) {
    const all = React.useMemo(() => workflowV2Activity(workflowLogEvents(events, { runId, runs }), { runId: null, limit: Infinity }), [events, runId, runs]);
    const listRef = React.useRef(null);
    // Stage 2.4 (FU-26): the replay's visit is the marked line, kept in view as the replay moves. Review S2UI-F7: the Log
    // lists the lines around that visit when its line is older than the newest ones.
    const current = replay?.current ?? null;
    const shown = React.useMemo(() => workflowLogWindow(all, current), [all, current]);
    const rows = shown.rows;
    // Review S2UI-F7: a replayed visit whose line is older than the loaded events reads the Workflow's older events, page by
    // page, until its line is loaded or there are none left to read. It reads again only when a page added older events
    // (the oldest loaded event changed), so a read that adds none (the history's size cap, a failure) ends it.
    const missing = Boolean(current) && !shown.found;
    const older = replay?.older ?? null;
    const oldest = Array.isArray(events) && events.length ? events[0]?.seq ?? null : null;
    const [reading, setReading] = React.useState(false);
    React.useEffect(() => {
        if (!missing || older?.more !== true || typeof older.load !== "function") { setReading(false); return undefined; }
        let live = true;
        setReading(true);
        Promise.resolve().then(() => older.load()).catch(() => {}).finally(() => { if (live) setReading(false); });
        return () => { live = false; };
    }, [missing, older?.more, oldest]);
    React.useEffect(() => {
        if (!current) return;
        listRef.current?.querySelector?.('[aria-current="step"]')?.scrollIntoView?.({ block: "nearest" });
    }, [current, shown.found]);
    if (!rows.length) return h("p", { className: "ps-wf-muted" }, "Nothing yet.");
    const visit = row => row.eventType === "workflow.state_started" && row.nodeExecutionId && replay?.visits?.has(row.nodeExecutionId) ? row.nodeExecutionId : null;
    const note = missing
        ? h("p", { className: "ps-wf-muted", role: "status", "data-log": "missing" }, reading
            ? "Reading older lines…" : "This visit's line is not loaded.")
        : shown.around ? h("p", { className: "ps-wf-muted", "data-log": "around" }, "Around the replayed run. Back to now shows the newest.")
        : null;
    return h(React.Fragment, null, note, h("ol", { className: "ps-wf-log", "aria-label": "Workflow log", ref: listRef },
        rows.map((row, index) => {
            const id = visit(row);
            const isCurrent = id !== null && id === current;
            const text = `${row.what}${row.who ? ` · ${row.who}` : ""}`;
            return h("li", { key: row.seq ?? index, "data-level": row.level, className: isCurrent ? "is-current" : undefined,
                "aria-current": isCurrent ? "step" : undefined, title: row.title ?? undefined },
                row.at ? h("time", { title: row.atTitle ?? undefined }, row.at) : null,
                id !== null
                    ? h("button", { type: "button", className: "ps-link-button", "data-action": "replay-visit", "data-visit": id,
                        title: "Show the graph as it was when this began", onClick: () => replay.onVisit(id) }, text)
                    : h("span", null, text));
        })));
}

/** A dialog in the portal's style, closed by Escape, by its ✕ and by the backdrop. */
export function Dialog({ title, onClose, children, footer, className = "" }) {
    const titleId = `wf-dialog-${React.useId().replace(/:/g, "")}`;
    const backdropRef = React.useRef(null);
    const closeRef = React.useRef(onClose);
    closeRef.current = onClose;
    // UX2D-F2: the keyboard keeps the dialog when focus has left it (a request that ended moved it to the page, behind the
    // backdrop): Escape still closes it, and Tab goes back into it. Keys from inside it are its own (the backdrop's
    // Escape, ModalDialog's Tab), and run as before.
    React.useEffect(() => {
        if (typeof document === "undefined") return undefined;
        const onKey = event => {
            const backdrop = backdropRef.current;
            if (!backdrop || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
            const active = document.activeElement;
            if (active && active !== document.body && backdrop.contains(active)) return;
            const dialog = backdrop.querySelector('[role="dialog"]');
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeRef.current();
            } else if (event.key === "Tab" && dialog) {
                event.stopPropagation();
                dialogKey(event, dialog);
            }
        };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
    }, []);
    const body = h("div", { ref: backdropRef, className: "ps-modal-backdrop", onClick: onClose,
        onKeyDown: event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); } } },
        h(ModalDialog, { className: `ps-modal is-narrow ps-wf-dialog${className ? ` ${className}` : ""}`, titleId },
            h("div", { className: "ps-modal-header" },
                h("div", { className: "ps-modal-title", id: titleId }, title),
                h("button", { type: "button", className: "ps-modal-close", onClick: onClose, "aria-label": "Close", title: "Close" }, "✕")),
            h("div", { className: "ps-modal-body ps-wf-dialog-body" }, children),
            footer ? h("div", { className: "ps-wf-dialog-foot" }, footer) : null));
    return typeof document === "undefined" ? body : createPortal(body, document.body);
}

/**
 * W9, O7: one Stop dialog. Let started nodes finish, then cancel (a graceful stop), or Cancel now; either way the Workflow
 * ends as Canceled (review 19:10Z, D-W11). The close button says Keep running.
 */
function StopDialog({ controller, sessionId, runId, title, stop, cancel, onClose }) {
    const [choice, setChoice] = React.useState(stop?.enabled ? "stop" : "cancel");
    const [busy, setBusy] = React.useState(false);
    const send = async () => {
        if (!runId || busy) return;
        setBusy(true);
        const result = await controller.sendWorkflowRunCommand(sessionId, { operation: choice, runId, confirmed: true });
        setBusy(false);
        if (result?.ok || result?.reason === "failed" || result?.reason === "unconfirmed") onClose();
    };
    const option = (value, label, note, control) => h("label", { className: `ps-wf-choice${control?.enabled ? "" : " is-disabled"}` },
        h("input", { type: "radio", name: "wf-stop", value, checked: choice === value, disabled: !control?.enabled, onChange: () => setChoice(value) }),
        h("span", null, h("strong", null, label), h("small", null, control?.enabled ? note : control?.title ?? "Not available for this Workflow.")));
    return h(Dialog, { title: `Stop ${title}`, onClose, className: "is-stop",
        footer: [
            h("button", { key: "keep", type: "button", className: "ps-mini-button", onClick: onClose }, "Keep running"),
            h("button", { key: "stop", type: "button", className: "ps-mini-button is-danger", "data-operation": choice, disabled: !runId,
                // UX2D-F2: busy is aria-disabled, not disabled, so the focused button keeps focus while the request runs.
                "aria-disabled": busy || undefined, onClick: send }, busy ? "Stopping…" : "Stop"),
        ] },
        h("div", { className: "ps-wf-choices", role: "radiogroup", "aria-label": "How to stop" },
            option("stop", "Let started nodes finish, then cancel", "No new node starts; started nodes get up to 60 s.", stop),
            option("cancel", "Cancel now", "Started nodes are canceled.", cancel)),
        h("p", { className: "ps-wf-muted" }, "Effects that already happened are not undone."));
}


/** Whether the Start form can draw a field for one input property (F-1); anything else is edited as JSON (F-4). */
const drawable = workflowV2DrawableInput;

/** What a field's type is called (F-1). */
function typeWords(property) {
    if (Array.isArray(property?.enum)) return "one of a list";
    if (property?.type === "array") return property.items?.type === "string" ? "list of text" : "list of numbers";
    return { string: "text", number: "number", integer: "number", boolean: "yes or no" }[property?.type] ?? "value";
}

/** A list input as chips with ✕, and an add box (F-1). */
function ChipsField({ value, onChange, numbers, label }) {
    const [draft, setDraft] = React.useState("");
    const items = Array.isArray(value) ? value : [];
    const add = () => {
        const text = draft.trim();
        if (!text) return;
        const item = numbers ? Number(text) : text;
        if (numbers && !Number.isFinite(item)) return;
        onChange([...items, item]);
        setDraft("");
    };
    return h("span", { className: "ps-wf-chips" },
        items.map((item, index) => h("span", { key: `${index}:${String(item)}`, className: "ps-wf-chip" }, String(item),
            h("button", { type: "button", "aria-label": `Remove ${String(item)}`, onClick: () => onChange(items.filter((_, at) => at !== index)) }, "✕"))),
        h("input", { className: "ps-workflow-input ps-wf-chip-input", value: draft, "aria-label": `Add to ${label}`, placeholder: "+ add",
            onChange: event => setDraft(event.target.value),
            onKeyDown: event => { if (event.key === "Enter") { event.preventDefault(); add(); } }, onBlur: add }));
}

/** One typed input field of the Start form (F-1). */
function InputField({ name, property, required, value, onChange }) {
    const id = `wf-in-${React.useId().replace(/:/g, "")}`;
    const head = [name, typeWords(property), required ? "required" : property?.default !== undefined ? `default ${JSON.stringify(property.default)}` : "optional"].join(" · ");
    let control;
    if (Array.isArray(property.enum)) {
        control = h("select", { id, className: "ps-workflow-input", value: JSON.stringify(value ?? null), onChange: event => onChange(JSON.parse(event.target.value)) },
            property.enum.map(option => h("option", { key: JSON.stringify(option), value: JSON.stringify(option) }, String(option))));
    } else if (property.type === "boolean") {
        control = h("input", { id, type: "checkbox", role: "switch", checked: value === true, onChange: event => onChange(event.target.checked) });
    } else if (property.type === "number" || property.type === "integer") {
        control = h("input", { id, type: "number", className: "ps-workflow-input", value: value ?? "",
            onChange: event => onChange(event.target.value === "" ? undefined : Number(event.target.value)) });
    } else if (property.type === "array") {
        control = h(ChipsField, { value, onChange, numbers: property.items?.type !== "string", label: name });
    } else {
        control = h("input", { id, type: "text", className: "ps-workflow-input", value: value ?? "", onChange: event => onChange(event.target.value) });
    }
    return h("div", { className: "ps-wf-field" }, h("label", { htmlFor: id }, head), control);
}

/**
 * F-1–F-7: Start asks only for what the definition needs, filled with sample values. With `onAsk` (Run again, W8) it is
 * the form for another Workflow of a started definition: the same fields, and its button asks the chat to start it
 * (`onAsk({ inputs, vars })`, answering { ok, reason }); nothing is sent to the engine from here.
 *
 * Review UI-13: a schema the form cannot draw, or that asks for input without listing it, gets a JSON box, never "Takes
 * no inputs". Start another (`source`: the Workflow it repeats, its number and its inputs) is filled with that
 * Workflow's own inputs, never sample values; when the read does not have them it says so and asks the chat to use the
 * same ones (inputs undefined), unless the person chooses to give others.
 */
export function StartDialog({ controller, sessionId, publication, control = null, name, number, onClose, onStarted, onAsk = null, source = null,
    startWith = null, models = null }) {
    const schema = publication.inputsSchema && typeof publication.inputsSchema === "object" ? publication.inputsSchema : null;
    const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
    const keys = Object.keys(properties);
    const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
    // Stage 2.1b: Run again (`startWith` with a `source`) starts the revision of the Workflow it repeats, filled with its inputs
    // when its read has them, else with sample values.
    const repeating = Boolean(onAsk) || Boolean(startWith && source);
    const repeated = repeating && source?.inputs && typeof source.inputs === "object" ? source.inputs : null;
    // Review UI-D8: Start another never erases the inputs its Workflow had: with no schema, its known inputs stay, as JSON.
    const shape = repeating ? workflowV2StartAnotherShape(schema, { schemaKnown: publication.inputsSchemaKnown === true }) : workflowV2InputsShape(schema);
    const sample = React.useMemo(() => (onAsk ? repeated ?? {} : repeated ?? workflowV2SampleInputs(schema) ?? {}),
        [JSON.stringify(schema ?? null), JSON.stringify(repeated)]);
    const [asJson, setAsJson] = React.useState(shape === "json");
    const [values, setValues] = React.useState(() => ({ ...sample }));
    const [jsonText, setJsonText] = React.useState(() => JSON.stringify(sample, null, 2));
    // Start another whose source inputs are not known: the same ones (the chat has them) until the person gives others.
    const [sameInputs, setSameInputs] = React.useState(Boolean(onAsk) && repeated === null && shape !== "none");
    const [varsOpen, setVarsOpen] = React.useState(false);
    const [varsText, setVarsText] = React.useState("{}");
    const [error, setError] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const revision = publication.state === "draft" ? publication.revision : publication.publishedRevision;
    const toJson = () => { setJsonText(JSON.stringify(values, null, 2)); setAsJson(true); };
    const send = async () => {
        if (busy) return;
        let inputs = values;
        if (shape === "none") inputs = {};
        else if (sameInputs) inputs = undefined;
        else if (asJson) {
            const parsed = workflowV2JsonObjectDraft(jsonText, { label: "Inputs" });
            if (!parsed.ok) { setError(parsed.error); return; }
            inputs = parsed.value;
        }
        let vars;
        if (varsOpen) {
            const parsed = workflowV2JsonObjectDraft(varsText, { label: "Variables", optional: true });
            if (!parsed.ok) { setError(parsed.error); return; }
            vars = parsed.value && Object.keys(parsed.value).length ? parsed.value : undefined;
        }
        setError(null);
        setBusy(true);
        if (startWith) {
            const started = await startWith({ inputs: inputs ?? {}, vars });
            setBusy(false);
            if (started?.ok) onStarted(started);
            // Review 21:15Z: "Start refused: <why>"; an answer that never came keeps its own words (it may have started).
            else setError(started?.phase === "unconfirmed" && started?.message ? started.message
                : workflowRefusalText("Start refused", started?.message, "the Workflow was not started."));
            return;
        }
        if (onAsk) {
            const asked = await onAsk({ inputs, vars, noInputs: shape === "none" });
            setBusy(false);
            if (asked?.ok) onStarted();
            else setError(asked?.reason || "The message to the chat was not sent.");
            return;
        }
        const command = control.operation === "start"
            ? { operation: "start", definitionHash: publication.publishedDefinitionHash, inputs, ...(vars ? { vars } : {}) }
            : { operation: "publish_and_start", expectedRevision: publication.revision, definitionHash: publication.definitionHash, inputs, ...(vars ? { vars } : {}) };
        const result = await controller.sendWorkflowRunCommand(sessionId, command);
        setBusy(false);
        if (result?.ok) onStarted();
        else if (result?.error) setError(workflowRefusalText("Start refused", result.error.message, "the Workflow was not started."));
    };
    return h(Dialog, { title: onAsk ? `Start another ${name}` : startWith && source ? `Run ${name} again` : `Start ${name}`, onClose, className: "is-start",
        footer: [
            startWith
                ? h("button", { key: "start", type: "button", className: "ps-mini-button is-primary", "data-action": source ? "run-again" : "start-revision",
                    "aria-disabled": busy || undefined, onClick: send }, busy ? "Starting…" : `Start #${number}`)
                : onAsk
                ? h("button", { key: "start", type: "button", className: "ps-mini-button is-primary", "data-action": "ask-start-another",
                    "aria-disabled": busy || undefined, onClick: send }, busy ? "Sending…" : `Ask the chat to start #${number}`)
                : h("button", { key: "start", type: "button", className: "ps-mini-button is-primary", "data-operation": control.operation,
                    disabled: !control.enabled, "aria-disabled": busy || undefined, title: control.enabled ? undefined : control.title, onClick: send },
                    busy ? "Starting…" : `Start #${number}`),
            // One way to leave without starting in words (the ✕ is the dialog's Close).
            h("button", { key: "cancel", type: "button", className: "ps-mini-button", onClick: onClose }, "Cancel"),
            h("span", { key: "note", className: "ps-wf-muted" }, onAsk
                ? `The chat starts ${name} #${number} from the same definition.`
                : `Workflow #${number} runs revision ${revision ?? "—"}.`),
        ] },
        h("p", { className: "ps-wf-muted ps-wf-dialog-sub" }, `revision ${revision ?? "—"} · ${publication.valid ? "valid" : "not valid"}`),
        repeated && shape !== "none" ? h("p", { className: "ps-wf-muted", "data-field": "from-source" },
            `Filled with the inputs of ${source?.number ? `#${source.number}` : "the Workflow it repeats"}.`) : null,
        startWith && source && !repeated && shape !== "none" ? h("p", { className: "ps-wf-muted", "data-field": "source-unread" },
            `This screen cannot read the inputs of ${source?.number ? `#${source.number}` : "the Workflow it repeats"}, so it shows sample values.`) : null,
        shape === "none"
            ? h("div", { className: "ps-wf-field" }, h("span", { className: "ps-wf-label" }, "Inputs"), h("p", { "data-field": "no-inputs" }, "Takes no inputs."))
            : sameInputs
                ? h("div", { className: "ps-wf-field" }, h("span", { className: "ps-wf-label" }, "Inputs"),
                    h("p", { "data-field": "same-inputs" }, `The same as ${source?.number ? `#${source.number}` : "before"}. This screen cannot read them; `
                        + "the chat uses the ones it started it with. ",
                    h("button", { type: "button", className: "ps-link-button", "data-action": "other-inputs", onClick: () => setSameInputs(false) }, "Give other inputs")))
            : asJson
                ? h("div", { className: "ps-wf-field" },
                    h("label", { htmlFor: `${sessionId}-inputs-json`, title: "JSON" }, "Inputs"),
                    h("textarea", { id: `${sessionId}-inputs-json`, className: "ps-workflow-input is-code", rows: Math.min(10, Math.max(3, jsonText.split("\n").length)),
                        value: jsonText, spellCheck: false, onChange: event => setJsonText(event.target.value) }))
                : h(React.Fragment, null,
                    h("div", { className: "ps-wf-field-actions" }, h("button", { type: "button", className: "ps-link-button", onClick: toJson }, "Edit as JSON")),
                    keys.map(key => h(InputField, { key, name: key, property: properties[key], required: required.has(key), value: values[key],
                        onChange: value => setValues(current => {
                            const next = { ...current };
                            if (value === undefined) delete next[key]; else next[key] = value;
                            return next;
                        }) }))),
        // OF-S2-7: what each agent node will use; a person does not choose it here.
        Array.isArray(models) && models.length ? h("div", { className: "ps-wf-field", "data-field": "models" },
            h("span", { className: "ps-wf-label" }, "Models"),
            h("ul", { className: "ps-wf-models" }, models.map(entry => h("li", { key: entry.id }, entry.text)))) : null,
        h("div", { className: "ps-wf-field" },
            h("span", { className: "ps-wf-label" }, "Variables · optional"),
            varsOpen
                ? h("textarea", { className: "ps-workflow-input is-code", rows: 3, "aria-label": "Variables", title: "JSON", value: varsText, spellCheck: false,
                    onChange: event => setVarsText(event.target.value) })
                : h("p", null, "None. ", h("button", { type: "button", className: "ps-link-button", onClick: () => setVarsOpen(true) }, "Add"))),
        error ? h("p", { role: "alert", className: "ps-wf-line is-error" }, error) : null);
}

/**
 * The Workflow button's badge (L2, O6) for the session whose chat is on screen: Workflows waiting for input, and failed
 * ones not yet opened.
 */
export { workflowBadgeCount } from "../../core/src/workflow-owner.js";
