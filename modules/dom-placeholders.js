import { tokenizePlaceholders, fingerprint } from './placeholders.js';

// Capture text-node boundaries before touching the DOM. Range handles a marker
// split across spans/Markdown elements; reverse mutation keeps offsets valid.
export function locateMarkers(root) {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, 4, {
        acceptNode(node) {
            return node.parentElement?.closest('script,style,textarea,pre,code,.sl_img_block,[data-sl-slot]') ? 2 : 1;
        }
    });
    const nodes = [];
    let text = '', node;
    while ((node = walker.nextNode())) {
        nodes.push({ node, start: text.length, end: text.length + node.length });
        text += node.nodeValue;
        // A marker may cross inline nodes, but never unrelated block containers.
        const parent = node.parentElement?.closest('p,div,li,section,article,tr');
        const next = walker.nextNode();
        if (next) {
            walker.currentNode = node;
            if (parent !== next.parentElement?.closest('p,div,li,section,article,tr')) text += '\n';
        } else walker.currentNode = node;
    }
    return tokenizePlaceholders(text).map(token => {
        const first = nodes.find(n => n.start <= token.start && n.end > token.start);
        const last = nodes.find(n => n.start < token.end && n.end >= token.end);
        if (!first || !last) return null;
        const range = doc.createRange();
        range.setStart(first.node, token.start - first.start);
        range.setEnd(last.node, token.end - last.start);
        return { ...token, range };
    }).filter(Boolean);
}

export function mountSlots(root, tokens, key, blocks) {
    const doc = root.ownerDocument;
    const markers = locateMarkers(root);
    // Match exact source tokens in DOM order. Never attach unmatched images to
    // another marker or append them at an arbitrary end-of-message position.
    let cursor = 0;
    const matches = [];
    for (const token of tokens) {
        const id = key + '#' + token.index;
        if (Array.from(root.querySelectorAll('[data-sl-slot]')).some(n => n.dataset.slSlot === id)) continue;
        let at = -1;
        for (let i = cursor; i < markers.length; i++) {
            const normalize = s => s.replace(/<[^>]*>/g, '').replace(/[*`]/g, '').replace(/\s+/g, '');
            if (normalize(markers[i].content) === normalize(token.content)) { at = i; break; }
        }
        if (at < 0) continue;
        cursor = at + 1;
        matches.push({ token, marker: markers[at], id });
    }
    for (const { token, marker, id } of matches.reverse()) {
        const slot = doc.createElement('span');
        slot.dataset.slSlot = id;
        slot.dataset.slOriginal = token.text;
        slot.style.display = 'block';
        const block = blocks?.[token.index];
        if (block) { slot.innerHTML = block.html; slot.dataset.slRendered = fingerprint(block.html); }
        else { slot.textContent = '🐱 正在分析第 ' + (token.index + 1) + ' 张图…'; slot.setAttribute('role', 'status'); }
        marker.range.deleteContents();
        marker.range.insertNode(slot);
    }
    return matches.length;
}

export function updateSlots(root, key, blocks) {
    for (const slot of root.querySelectorAll('[data-sl-slot]')) {
        if (!slot.dataset.slSlot.startsWith(key + '#')) continue;
        const index = Number(slot.dataset.slSlot.slice((key + '#').length));
        if (blocks[index]) {
            const hash = fingerprint(blocks[index].html);
            if (slot.dataset.slRendered !== hash) slot.innerHTML = blocks[index].html;
            slot.dataset.slRendered = hash;
            slot.removeAttribute('role'); slot.classList.remove('sl_scan_retry');
        }
    }
}

export function resetSlots(root) {
    for (const slot of root.querySelectorAll('[data-sl-slot]')) {
        slot.replaceWith(root.ownerDocument.createTextNode(slot.dataset.slOriginal || ''));
    }
}
