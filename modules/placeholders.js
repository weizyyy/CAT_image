// Shared lexical scanner: offsets always refer to the original, unmodified source.
// Handles multiline markers, full-width punctuation, nested brackets and escaped ].
export function tokenizePlaceholders(source) {
    const text = String(source || '');
    const out = [];
    const opener = /[\[［]img\s*[:：]/gi;
    let match;
    while ((match = opener.exec(text))) {
        let end = opener.lastIndex, depth = 1;
        for (; end < text.length; end++) {
            if (text[end] === '\\') { end++; continue; }
            if (text[end] === '[' || text[end] === '［') {
                // Recover at a new marker if the previous one was left unclosed.
                if (/^[\[［]img\s*[:：]/i.test(text.slice(end))) break;
                depth++;
            }
            if (text[end] === ']' || text[end] === '］') {
                if (--depth === 0) break;
            }
        }
        if (depth !== 0) { opener.lastIndex = Math.max(end, opener.lastIndex); continue; }
        const content = text.slice(match.index + match[0].length, end).trim();
        if (content) out.push({ index: out.length, start: match.index, end: end + 1,
            text: text.slice(match.index, end + 1), content });
        opener.lastIndex = end + 1;
    }
    return out;
}

export function fingerprint(source) {
    // Two independent 32-bit hashes of the WHOLE response, not a text prefix.
    const text = String(source || '');
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
        a = Math.imul(a ^ text.charCodeAt(i), 16777619);
        b = Math.imul(b, 33) ^ text.charCodeAt(i);
    }
    return text.length + '-' + (a >>> 0).toString(36) + '-' + (b >>> 0).toString(36);
}

export function messageKey(chatId, messageId, source, swipe = 0) {
    return chatId + '_' + messageId + '_v2_' + swipe + '_' + fingerprint(source);
}

export function replaceTokens(source, tokens, values) {
    let result = String(source), cursor = 0, out = '';
    for (const token of tokens) {
        out += result.slice(cursor, token.start) + (values[token.index] ?? token.text);
        cursor = token.end;
    }
    return out + result.slice(cursor);
}
