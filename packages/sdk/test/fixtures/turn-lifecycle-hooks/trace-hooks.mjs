export async function beforeTurn(context) {
    context.trace(`fixture-before:${context.sessionId}`);
}

export async function afterTurn(context) {
    context.trace(`fixture-after:${context.sessionId}:${context.status}`);
}
