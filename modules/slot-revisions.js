import { tokenizePlaceholders } from './placeholders.js';

// Match occurrences, never a prompt-wide lookup: identical markers still own
// distinct images. Source prefix/suffix anchors disambiguate local duplicate edits.
export function reconcileSlots(source, key, previous) {
    const next = tokenizePlaceholders(source);
    const slots = next.map(t => ({ id: key + '#' + t.index }));
    if (!previous) return slots;
    const old = tokenizePlaceholders(previous.source), used = new Set(), matches = new Map();
    const keep = (a, b) => {
        if (!used.has(a) && !matches.has(b) && old[a]?.text === next[b]?.text) {
            used.add(a); matches.set(b, a);
        }
    };
    let prefix = 0, suffix = 0;
    while (prefix < source.length && prefix < previous.source.length && source[prefix] === previous.source[prefix]) prefix++;
    while (suffix < source.length - prefix && suffix < previous.source.length - prefix &&
        source[source.length - 1 - suffix] === previous.source[previous.source.length - 1 - suffix]) suffix++;
    const byStart = new Map(old.map(t => [t.start, t.index]));
    for (const t of next) {
        if (t.end <= prefix) keep(byStart.get(t.start), t.index);
        else if (t.start >= source.length - suffix) keep(byStart.get(t.start + previous.source.length - source.length), t.index);
    }
    // Align the remaining sequence between anchors; each old occurrence is used once.
    const anchors = [[-1, -1], ...Array.from(matches, ([b, a]) => [a, b]).sort((a, b) => a[1] - b[1]), [old.length, next.length]];
    for (let n = 1; n < anchors.length; n++) {
        const [a0, b0] = anchors[n - 1], [a1, b1] = anchors[n];
        const a = old.slice(a0 + 1, a1), b = next.slice(b0 + 1, b1);
        if (a.length * b.length > 1e6) continue; // Bound memory for pathological responses.
        const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
        for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
            dp[i][j] = a[i].text === b[j].text ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
        for (let i = 0, j = 0; i < a.length && j < b.length;) {
            if (a[i].text === b[j].text) { keep(a[i++].index, b[j++].index); }
            else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
        }
    }
    for (const [b, a] of matches) if (previous.slots?.[a]?.id) slots[b] = { ...previous.slots[a] };
    return slots;
}
