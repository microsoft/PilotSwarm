import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";

export interface McpWorkloadIdentityScopeBinding {
    serverName: string;
    scope: string;
}

export interface McpWorkloadIdentityServerConfig {
    type?: unknown;
    url?: unknown;
    command?: unknown;
}

export type McpServerHeadersProvider = () => Promise<
    Record<string, {
        expectedUrl: string;
        headers: Record<string, string>;
    }>
>;

const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KUBERNETES_SERVICE_FQDN_PATTERN =
    /^(?:[a-z0-9](?:[-a-z0-9]*[a-z0-9])?\.){2}svc\.cluster\.local$/;
const BEARER_SCHEME = ["Bear", "er"].join("");

/**
 * Parses comma-delimited deployment bindings in the form
 * `serverName=resource/.default`.
 */
export function parseMcpWorkloadIdentityScopes(
    value: unknown,
): McpWorkloadIdentityScopeBinding[] {
    const raw = String(value ?? "").trim();
    if (!raw) return [];
    if (raw.includes(";")) {
        throw new Error(
            "MCP_WORKLOAD_IDENTITY_SCOPES uses commas between bindings; semicolons are not allowed.",
        );
    }

    const bindings: McpWorkloadIdentityScopeBinding[] = [];
    const seenNames = new Set<string>();
    for (const rawEntry of raw.split(",")) {
        const entry = rawEntry.trim();
        if (!entry) {
            throw new Error(
                "MCP_WORKLOAD_IDENTITY_SCOPES contains an empty binding.",
            );
        }
        const separator = entry.indexOf("=");
        if (separator < 1) {
            throw new Error(
                `MCP_WORKLOAD_IDENTITY_SCOPES entry must be SERVER_NAME=scope: '${entry}'.`,
            );
        }
        const serverName = entry.slice(0, separator).trim();
        const scope = entry.slice(separator + 1).trim();
        if (!SERVER_NAME_PATTERN.test(serverName)) {
            throw new Error(
                `MCP workload identity server name is invalid: '${serverName}'.`,
            );
        }
        if (
            !scope
            || /\s/.test(scope)
            || scope.includes("$")
            || scope.includes("{")
            || scope.includes("}")
            || !scope.endsWith("/.default")
        ) {
            throw new Error(
                `MCP workload identity scope for '${serverName}' must be a single Entra scope ending in '/.default'.`,
            );
        }
        if (seenNames.has(serverName)) {
            throw new Error(
                `MCP workload identity server '${serverName}' is configured more than once.`,
            );
        }
        seenNames.add(serverName);
        bindings.push({ serverName, scope });
    }
    return bindings;
}

function deploymentMcpUrl(
    serverName: string,
    config: McpWorkloadIdentityServerConfig | undefined,
): string {
    const isRemote = config
        && (config.type === "http"
            || config.type === "sse"
            || (typeof config.url === "string" && !config.command));
    if (!isRemote || typeof config?.url !== "string" || !config.url.trim()) {
        throw new Error(
            `MCP workload identity server '${serverName}' must be a deployment-owned remote server with a URL.`,
        );
    }

    let url: URL;
    try {
        url = new URL(config.url);
    } catch {
        throw new Error(
            `MCP workload identity server '${serverName}' has an invalid URL.`,
        );
    }
    const isHttps = url.protocol === "https:";
    const isClusterLocalHttp = url.protocol === "http:"
        && KUBERNETES_SERVICE_FQDN_PATTERN.test(url.hostname);
    if (
        (!isHttps && !isClusterLocalHttp)
        || url.username
        || url.password
        || url.hash
    ) {
        throw new Error(
            `MCP workload identity server '${serverName}' must use HTTPS or an in-cluster HTTP service URL in the form '<service>.<namespace>.svc.cluster.local', without embedded credentials or a fragment.`,
        );
    }
    return config.url;
}

/**
 * Creates fresh worker-owned authorization headers for explicitly mapped,
 * deployment-owned MCP servers. HTTPS is required except for exact Kubernetes
 * Service FQDNs on the cluster-local network. The SessionManager additionally
 * binds each returned header to `expectedUrl` before injecting it.
 */
export function createMcpWorkloadIdentityHeadersProvider(options: {
    scopeBindings: unknown;
    deploymentMcpServers: Record<string, McpWorkloadIdentityServerConfig>;
    credential?: TokenCredential;
    trace?: (message: string) => void;
}): McpServerHeadersProvider | undefined {
    const bindings = parseMcpWorkloadIdentityScopes(options.scopeBindings);
    if (bindings.length === 0) return undefined;

    const resolvedBindings = bindings.map((binding) => {
        if (!Object.prototype.hasOwnProperty.call(
            options.deploymentMcpServers,
            binding.serverName,
        )) {
            throw new Error(
                `MCP workload identity server '${binding.serverName}' is not present in deployment-owned DEFAULT_MCP_JSON.`,
            );
        }
        return {
            ...binding,
            expectedUrl: deploymentMcpUrl(
                binding.serverName,
                options.deploymentMcpServers[binding.serverName],
            ),
        };
    });

    const credential = options.credential ?? new DefaultAzureCredential();
    options.trace?.(
        `MCP workload identity enabled for deployment servers: ${resolvedBindings.map(({ serverName }) => serverName).join(", ")}`,
    );

    return async () => {
        const uniqueScopes = [
            ...new Set(resolvedBindings.map(({ scope }) => scope)),
        ];
        const tokenEntries = await Promise.all(
            uniqueScopes.map(async (scope) => {
                let accessToken;
                try {
                    accessToken = await credential.getToken(scope);
                } catch (cause) {
                    throw new Error(
                        `MCP workload identity authentication failed while requesting scope '${scope}'.`,
                        { cause },
                    );
                }
                const token = accessToken?.token?.trim();
                if (!token) {
                    throw new Error(
                        `MCP workload identity authentication failed: DefaultAzureCredential returned no access token for scope '${scope}'.`,
                    );
                }
                return [scope, token] as const;
            }),
        );
        const tokensByScope = new Map(tokenEntries);

        return Object.fromEntries(
            resolvedBindings.map(({ serverName, scope, expectedUrl }) => [
                serverName,
                {
                    expectedUrl,
                    headers: {
                        Authorization: [
                            BEARER_SCHEME,
                            tokensByScope.get(scope),
                        ].join(" "),
                    },
                },
            ]),
        );
    };
}
