/**
 * Agent tools for session clones (docs/proposals/session-workspaces.md, 12.1).
 * They call the repo service, so the agent never runs git on a mirror.
 *
 *   create_session_clone({ repo })   a clone for this session tree; returns the workspace record
 *   list_session_clones()            this tree's clones
 *   remove_session_clone({ repo })   delete one (refused while a session is using it)
 *
 * Clones belong to the session tree: the tools look up the calling session's
 * root in the worker's catalog.
 */
async function callService(baseUrl, method, pathname, body) {
    const response = await fetch(new URL(pathname, baseUrl), {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${data?.error?.code ?? `HTTP ${response.status}`}: ${data?.error?.message ?? ""}`.trim());
    return data;
}

/**
 * @param {object} options
 * @param {string} options.serviceUrl
 * @param {() => ({ getSession(id: string): Promise<any> } | null)} [options.getCatalog]  the worker's session catalog
 */
export function createRepoTools({ serviceUrl, getCatalog }) {
    const treeOf = async (invocation) => {
        const sessionId = invocation?.durableSessionId;
        if (!sessionId) throw new Error("this tool needs the calling session's id");
        const row = await getCatalog?.()?.getSession(sessionId).catch(() => null);
        return row?.rootSessionId || sessionId;
    };
    const json = (value) => JSON.stringify(value);
    return [
        {
            name: "create_session_clone",
            description:
                "Make a clone of a repo for this session tree (or return the existing one) and give back its workspace "
                + "record { root, folder }. Then call set_session_workspace with it to work there, or pass it to "
                + "spawn_agent as workspace to give a sub-agent its own checkout.",
            parameters: {
                type: "object",
                properties: { repo: { type: "string", description: "The repo name, as the deployment lists it" } },
                required: ["repo"],
            },
            handler: async (args, invocation) => json(await callService(serviceUrl, "POST", "/v1/clones", {
                rootSessionId: await treeOf(invocation),
                repo: args.repo,
            })),
        },
        {
            name: "list_session_clones",
            description: "List this session tree's repo clones and their workspace records.",
            parameters: { type: "object", properties: {} },
            handler: async (_args, invocation) => json(await callService(serviceUrl, "GET",
                `/v1/clones?rootSessionId=${encodeURIComponent(await treeOf(invocation))}`)),
        },
        {
            name: "remove_session_clone",
            description: "Delete one of this session tree's clones. Refused while any session is using it. Uncommitted work is lost.",
            parameters: {
                type: "object",
                properties: { repo: { type: "string", description: "The repo name of the clone to delete" } },
                required: ["repo"],
            },
            handler: async (args, invocation) => json(await callService(serviceUrl, "DELETE", "/v1/clones", {
                rootSessionId: await treeOf(invocation),
                repo: args.repo,
            })),
        },
    ];
}
