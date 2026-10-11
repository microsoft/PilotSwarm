/**
 * Workload-identity auth for Azure AI Foundry (Cognitive Services) providers.
 */

import { DefaultAzureCredential, type TokenCredential } from "@azure/identity";

export const FOUNDRY_AAD_SCOPE = "https://cognitiveservices.azure.com/.default";

let cachedCredential: TokenCredential | null = null;

function getCredential(): TokenCredential {
    if (!cachedCredential) cachedCredential = new DefaultAzureCredential();
    return cachedCredential;
}

export function _setFoundryAadCredentialForTests(credential: TokenCredential | null): void {
    cachedCredential = credential;
}

export function foundryBearerTokenProvider(
    deps: { credential?: TokenCredential } = {},
): () => Promise<string> {
    return async () => {
        const token = await (deps.credential ?? getCredential()).getToken(FOUNDRY_AAD_SCOPE);
        if (!token?.token) {
            throw new Error(
                "Failed to acquire an AAD token for Azure Cognitive Services "
                + `(scope ${FOUNDRY_AAD_SCOPE}). Verify DefaultAzureCredential can `
                + "authenticate the worker and its identity has the 'Cognitive Services "
                + "OpenAI User' role on the Foundry account.",
            );
        }
        return token.token;
    };
}
