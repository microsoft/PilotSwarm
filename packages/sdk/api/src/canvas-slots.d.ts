export declare const CANVAS_SLOT_MAX: 10;
export declare const CANVAS_SLOT_RANGE: string;
export declare const CANVAS_SLOT_ERROR: string;
export declare const CANVAS_EVENT_WINDOW: number;
export declare const CANVAS_KEY_SUFFIX: RegExp;
export declare function isCanvasSlot(n: unknown): n is number;
export declare function normalizeCanvasSlot(value: unknown): number | null;
export declare function canvasArtifactFilename(slot: number): string;
