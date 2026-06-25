export interface MiMoToolPartView {
    callId: string;
    name: string;
    status: string;
    args: any;
    result: any;
    isError: boolean;
}

function firstDefined(...values: any[]): any {
    for (const value of values) {
        if (value !== undefined && value !== null) return value;
    }
    return undefined;
}

export function normalizeMiMoToolPart(part: any): MiMoToolPartView {
    const state = part?.state && typeof part.state === 'object' ? part.state : {};
    const metadata = state.metadata && typeof state.metadata === 'object' ? state.metadata : {};
    const status = String(firstDefined(state.status, part?.status, '') || '');
    const output = firstDefined(
        state.output,
        state.result,
        metadata.output,
        metadata.result,
        part?.output,
        part?.result,
        '',
    );
    return {
        callId: String(firstDefined(part?.callID, part?.call_id, part?.toolCallId, state.callID, state.call_id, '') || ''),
        name: String(firstDefined(part?.tool, part?.name, state.tool, state.name, 'tool') || 'tool'),
        status,
        args: firstDefined(state.input, part?.input, part?.args, {}),
        result: output,
        isError: status === 'error' || !!firstDefined(state.error, part?.error, false),
    };
}
