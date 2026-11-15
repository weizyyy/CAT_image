// Treat workflows as opaque JSON text. Only substitute the literal %prompt%.
// Escape the inserted string for JSON without parsing or reserializing nodes.
export function substituteWorkflow(template, prompt) {
    return String(template || '').split('%prompt%').join(JSON.stringify(String(prompt || '')).slice(1, -1));
}

export function workflowRequest(template, prompt, clientId) {
    return '{"prompt":' + substituteWorkflow(randomizeZeroSeeds(template), prompt) + ',"client_id":' + JSON.stringify(clientId) + '}';
}

function randomSeed() {
    const data = new Uint32Array(2);
    globalThis.crypto.getRandomValues(data);
    return Math.max(1, (data[0] & 0x1fffff) * 4294967296 + data[1]);
}

// The only structural exception to opaque forwarding: the user-defined zero
// seed convention. A lexical walk records numeric spans, never deserializes or
// reserializes a workflow (64-bit integers and unknown nodes stay byte exact).
export function randomizeZeroSeeds(template, nextSeed = randomSeed) {
    const text = String(template || ''), edits = [];
    let cursor = 0;
    const whitespace = () => { while (/\s/.test(text[cursor] || '') && cursor < text.length) cursor++; };
    function value(depth = 0) {
        whitespace();
        if (depth > 256 || cursor >= text.length) throw new Error('opaque');
        const start = cursor, char = text[cursor];
        if (char === '"') {
            cursor++;
            while (cursor < text.length) {
                if (text[cursor] === '\\') { cursor += 2; continue; }
                if (text[cursor++] === '"') return { type: 'string', value: JSON.parse(text.slice(start, cursor)), start, end: cursor };
            }
            throw new Error('opaque');
        }
        if (char === '{') {
            cursor++; const fields = new Map(); whitespace();
            while (text[cursor] !== '}') {
                const key = value(depth + 1); whitespace();
                if (key.type !== 'string' || text[cursor++] !== ':') throw new Error('opaque');
                fields.set(key.value, value(depth + 1)); whitespace();
                if (text[cursor] === '}') break;
                if (text[cursor++] !== ',') throw new Error('opaque');
            }
            cursor++;
            const classType = fields.get('class_type')?.value;
            const inputs = fields.get('inputs')?.fields;
            if (typeof classType === 'string' && /sampler|randomnoise/i.test(classType) && inputs) {
                for (const name of ['seed', 'noise_seed']) {
                    const field = inputs.get(name);
                    if (field?.type === 'literal' && /^-?0(?:\.0+)?(?:[eE][+-]?\d+)?$/.test(field.value)) {
                        edits.push({ start: field.start, end: field.end, value: String(nextSeed()) });
                    }
                }
            }
            return { type: 'object', fields, start, end: cursor };
        }
        if (char === '[') {
            cursor++; whitespace();
            while (text[cursor] !== ']') {
                value(depth + 1); whitespace();
                if (text[cursor] === ']') break;
                if (text[cursor++] !== ',') throw new Error('opaque');
            }
            cursor++; return { type: 'array', start, end: cursor };
        }
        while (cursor < text.length && !/[\s,}\]]/.test(text[cursor])) cursor++;
        if (cursor === start) throw new Error('opaque');
        return { type: 'literal', value: text.slice(start, cursor), start, end: cursor };
    }
    try { value(); whitespace(); if (cursor !== text.length) return text; } catch { return text; }
    let out = text;
    for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.value + out.slice(edit.end);
    return out;
}
