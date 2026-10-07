export const PROMPT_HISTORY_LIMIT = 10;
export const PROMPT_HISTORY_EVENT_TYPES = ["user.message", "session.steering_accepted"];
export const PROMPT_HISTORY_MAX_PAGES = 3;
export const PROMPT_HISTORY_READ_BUDGET_MS = 5000;

export function promptDraftForPersistence(ui) {
    return ui.promptHistoryNavigation?.stash || (ui.promptEdit?.draftPrompt !== undefined ? {
        prompt: ui.promptEdit.draftPrompt, cursor: ui.promptEdit.draftCursor,
        attachments: ui.promptEdit.draftAttachments || [],
    } : null) || {
        prompt: ui.prompt || "", cursor: ui.promptCursor,
        attachments: ui.promptAttachments || [],
    };
}

export function promptHistoryActorKey(actor) {
    return actor?.provider && actor?.subject ? JSON.stringify([actor.provider, actor.subject]) : null;
}

function sameInput(a, b) {
    return a.ids.some(id => b.ids.includes(id));
}

export function promptHistoryEvent(event, viewer) {
    if (event?.eventType === "session.steering_accepted") {
        const receipt = event.data?.receipt;
        if (receipt?.schemaVersion !== 1 || !receipt.requestId
            || receipt.sessionId !== event.sessionId
            || !promptHistoryActorKey(viewer)
            || promptHistoryActorKey(receipt.actor) !== promptHistoryActorKey(viewer)
            || typeof receipt.text !== "string" || !receipt.text.trim()) return null;
        return { text: receipt.text, seq: event.seq, ids: [`steer:${receipt.requestId}`] };
    }
    if (event?.eventType !== "user.message" || event.data?.sender?.kind !== "user"
        || !promptHistoryActorKey(viewer)
        || promptHistoryActorKey(event.data.sender) !== promptHistoryActorKey(viewer)
        || typeof event.data.content !== "string" || !event.data.content.trim()) return null;
    const data = event.data;
    const ids = data.steering?.requestId ? [`steer:${data.steering.requestId}`]
        : (data.clientMessageIds || (data.clientMessageId ? [data.clientMessageId] : [])).map(id => `message:${id}`);
    return { text: data.content, seq: event.seq, ids: ids.length ? ids : [`event:${event.seq}`] };
}

export function mergePromptHistoryEvents(previous = [], events = [], viewer) {
    const ordered = [...previous, ...events.map(event => promptHistoryEvent(event, viewer)).filter(Boolean)]
        .sort((a, b) => b.seq - a.seq);
    const result = [];
    for (const entry of ordered) {
        if (result.some(item => sameInput(item, entry))) continue;
        if (result.at(-1)?.text === entry.text) {
            const last = result.at(-1);
            result[result.length - 1] = { ...last, ids: [...last.ids, ...entry.ids].slice(0, 100) };
        } else result.push(entry);
    }
    return result.slice(0, PROMPT_HISTORY_LIMIT);
}

export function mergePromptHistorySession(previous = {}, events = [], viewer) {
    const observed = events.map(event => promptHistoryEvent(event, viewer)).filter(Boolean);
    return {
        ...previous,
        durable: mergePromptHistoryEvents(previous.durable, events, viewer),
        accepted: (previous.accepted || []).filter(item => !observed.some(event => sameInput(item, event))),
    };
}

export function selectPromptHistory(state, sessionId = state.sessions.activeSessionId, { excludeOutbox = false } = {}) {
    if (!sessionId || !promptHistoryActorKey(state.auth?.principal)) return [];
    const entry = state.promptHistory?.bySessionId?.[sessionId] || {};
    const durable = mergePromptHistoryEvents(entry.durable, state.history.bySessionId.get(sessionId)?.events, state.auth.principal);
    const accepted = (entry.accepted || []).filter(item => !durable.some(event => sameInput(item, event)));
    const queuedIds = new Set(excludeOutbox
        ? (state.outbox?.bySessionId?.[sessionId] || []).flatMap(item => (item.clientMessageIds || []).map(id => `message:${id}`))
        : []);
    const result = [];
    for (const item of [...accepted, ...durable]) {
        if (item.ids.some(id => queuedIds.has(id))) continue;
        if (result.at(-1) !== item.text) result.push(item.text);
        if (result.length === PROMPT_HISTORY_LIMIT) break;
    }
    return result;
}

export function isPromptHistoryBoundary(text, cursor, direction) {
    const value = String(text || "");
    const at = Math.max(0, Math.min(Number(cursor) || 0, value.length));
    return direction < 0 ? !value.slice(0, at).includes("\n") : !value.slice(at).includes("\n");
}

export function navigatePromptHistory(state, direction, entries, { stash, outboxIds } = {}) {
    const sessionId = state.sessions.activeSessionId;
    const viewerKey = promptHistoryActorKey(state.auth?.principal);
    if (!sessionId || !viewerKey || !isPromptHistoryBoundary(state.ui.prompt, state.ui.promptCursor, direction)) return null;
    const current = state.ui.promptHistoryNavigation;
    const navigation = current?.sessionId === sessionId && current.viewerKey === viewerKey ? current : null;
    if (direction > 0 && !navigation) return null;
    if (direction < 0 && !navigation && !entries.length) return null;
    const list = navigation?.entries || entries;
    const index = (navigation?.index ?? -1) + (direction < 0 ? 1 : -1);
    if (index >= list.length) return null;
    if (index < 0) return { prompt: navigation.stash.prompt, promptCursor: navigation.stash.cursor,
        attachments: navigation.stash.attachments, navigation: null };
    return {
        prompt: list[index], promptCursor: list[index].length, attachments: [],
        navigation: {
            sessionId, viewerKey, entries: list, index,
            stash: navigation?.stash || stash || { prompt: state.ui.prompt, cursor: state.ui.promptCursor, attachments: state.ui.promptAttachments },
            ...(navigation?.outboxIds || outboxIds ? { outboxIds: navigation?.outboxIds || outboxIds } : {}),
        },
    };
}
