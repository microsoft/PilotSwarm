import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";

export const AZURE_DEVOPS_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";
export const AZURE_DEVOPS_MCP_SCOPE = "https://mcp.dev.azure.com/.default";

export type AzureDevOpsAccessTokenProvider = () => Promise<string>;
export interface AzureDevOpsAccessToken {
    token: string;
    expiresOnTimestamp: number;
}
export type AzureDevOpsTokenProvider = () => Promise<AzureDevOpsAccessToken>;
export type AzureDevOpsCredentialSource = "workload-identity" | "pat-fallback";

export interface AzureDevOpsCredential {
    token: string;
    source: AzureDevOpsCredentialSource;
}

export interface ResolveAzureDevOpsCredentialOptions {
    accessTokenProvider?: AzureDevOpsAccessTokenProvider;
    patFallbackProvider?: () => Promise<string | undefined>;
}

export function isAzureDevOpsPatFallbackEnabled(value: unknown): boolean {
    return ["1", "true", "yes", "on"].includes(
        String(value ?? "").trim().toLowerCase(),
    );
}

export function takeAzureDevOpsPatFromEnvironment(
    environment: Record<string, string | undefined> = process.env,
): string | undefined {
    const value = environment.ADO_PAT?.trim();
    delete environment.ADO_PAT;
    return value && value !== "__PS_UNSET__" ? value : undefined;
}

export function createAzureDevOpsTokenProvider(
    credential: TokenCredential = new DefaultAzureCredential(),
    scope = AZURE_DEVOPS_SCOPE,
): AzureDevOpsTokenProvider {
    return async () => {
        const accessToken = await credential.getToken(scope);
        if (!accessToken?.token) {
            throw new Error(
                "Azure DevOps authentication failed: DefaultAzureCredential returned no access token.",
            );
        }
        return accessToken;
    };
}

export function createAzureDevOpsAccessTokenProvider(
    credential: TokenCredential = new DefaultAzureCredential(),
    scope = AZURE_DEVOPS_SCOPE,
): AzureDevOpsAccessTokenProvider {
    const tokenProvider = createAzureDevOpsTokenProvider(credential, scope);
    return async () => (await tokenProvider()).token;
}

export function createAzureDevOpsMcpAccessTokenProvider(
    credential: TokenCredential = new DefaultAzureCredential(),
): AzureDevOpsAccessTokenProvider {
    return createAzureDevOpsAccessTokenProvider(
        credential,
        AZURE_DEVOPS_MCP_SCOPE,
    );
}

let defaultAccessTokenProvider: AzureDevOpsAccessTokenProvider | undefined;

export function getAzureDevOpsAccessToken(): Promise<string> {
    defaultAccessTokenProvider ??= createAzureDevOpsAccessTokenProvider();
    return defaultAccessTokenProvider();
}

/**
 * Resolves an Azure DevOps credential with workload identity as the primary
 * path and an available PAT as a compatibility fallback.
 */
export async function resolveAzureDevOpsCredential(
    options: ResolveAzureDevOpsCredentialOptions = {},
): Promise<AzureDevOpsCredential> {
    const accessTokenProvider =
        options.accessTokenProvider ?? getAzureDevOpsAccessToken;

    try {
        const token = (await accessTokenProvider()).trim();
        if (!token) {
            throw new Error(
                "Azure DevOps workload identity returned an empty access token.",
            );
        }
        return {
            token,
            source: "workload-identity",
        };
    } catch (workloadIdentityError) {
        const patFallback = await options.patFallbackProvider?.();
        if (patFallback?.trim()) {
            return {
                token: patFallback.trim(),
                source: "pat-fallback",
            };
        }

        throw workloadIdentityError;
    }
}

export function azureDevOpsGitAuthorizationHeader(
    credential: AzureDevOpsCredential,
): string {
    const token = credential.token?.trim();
    if (!token) {
        throw new Error("Azure DevOps Git authentication requires a non-empty credential.");
    }
    if (credential.source === "workload-identity") {
        return `AUTHORIZATION: bearer ${token}`;
    }
    const encoded = Buffer.from(`:${token}`, "utf8").toString("base64");
    return `AUTHORIZATION: Basic ${encoded}`;
}

export function azureDevOpsGitConfig(
    credential: AzureDevOpsCredential,
): Record<string, string> {
    return {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraheader",
        GIT_CONFIG_VALUE_0: azureDevOpsGitAuthorizationHeader(credential),
    };
}

export function isAzureDevOpsGitAuthenticationFailure(error: unknown): boolean {
    const candidate = error as {
        message?: unknown;
        stdout?: unknown;
        stderr?: unknown;
    };
    const text = [candidate?.message, candidate?.stdout, candidate?.stderr]
        .map((value) =>
            Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? ""))
        .join("\n");
    return /(?:authentication failed|tf401019|http (?:401|403)|returned error: (?:401|403)|you do not have permission)/i.test(text);
}

export function azureDevOpsMcpAuthorizationHeader(accessToken: string): string {
    if (!accessToken) {
        throw new Error("Azure DevOps MCP authentication requires a non-empty access token.");
    }
    return `Bearer ${accessToken}`;
}
