/**
 * Capability declaration for a model the Copilot catalog does not know.
 * Shared by durable sessions and isolated invocations.
 * @internal
 */
export function buildByokModelCapabilities(
    descriptor: any,
    contextTier?: string,
): { supports?: Record<string, boolean>; limits?: Record<string, unknown> } | undefined {
    if (!descriptor) return undefined;

    const supports: Record<string, boolean> = {};
    if (Array.isArray(descriptor.supportedReasoningEfforts) && descriptor.supportedReasoningEfforts.length > 0) {
        supports.reasoningEffort = true;
    }
    if (descriptor.vision) supports.vision = true;

    const limits: Record<string, unknown> = {};
    const sizes = descriptor.contextWindowSizes;
    if (sizes && typeof sizes === "object") {
        const tierValue = contextTier ? sizes[contextTier] : undefined;
        const window = Number.isFinite(tierValue)
            ? Number(tierValue)
            : Math.max(...Object.values(sizes).map((v) => Number(v)).filter((v) => Number.isFinite(v)), 0);
        if (window > 0) {
            limits.max_context_window_tokens = window;
            // The runtime uses max_prompt_tokens, not max_context_window_tokens
            // alone, for BYOK context sizing (pinned by byok-context-window tests).
            limits.max_prompt_tokens = window;
        }
    }
    if (descriptor.vision && typeof descriptor.vision === "object") {
        const v: Record<string, unknown> = {};
        if (Number.isFinite(descriptor.vision.maxImages)) v.max_prompt_images = Number(descriptor.vision.maxImages);
        if (Number.isFinite(descriptor.vision.maxImageBytes)) v.max_prompt_image_size = Number(descriptor.vision.maxImageBytes);
        if (Array.isArray(descriptor.vision.supportedMediaTypes)) v.supported_media_types = descriptor.vision.supportedMediaTypes;
        if (Object.keys(v).length > 0) limits.vision = v;
    }

    // A supports-only override cannot fix BYOK reasoning transmission and
    // would needlessly change runtime defaults. Keep the existing behavior.
    if (Object.keys(limits).length === 0) return undefined;
    return {
        ...(Object.keys(supports).length > 0 ? { supports } : {}),
        limits,
    };
}
