import { slLog, slErr } from './log.js';
import { settings, getSTContext, getActiveMode } from './settings.js';
import { runRosterPipeline } from './pipeline/roster-pipeline.js';
import { refreshCoopCards } from './sync-cards.js';
import { getChatId, sessionData, saveArchive } from './archive.js';
import { renderEnhancedLite, extractImgBlocksFromEnhanced } from './render.js';
import { messageKey, tokenizePlaceholders } from './placeholders.js';
import { reconcileSlots } from './slot-revisions.js';
import { resetSlots } from './dom-placeholders.js';
import { imgCacheGetById } from './cache.js';
import { isImagePending } from './queue.js';
import { galleryAdd, galleryCacheSource } from './gallery.js';
import { ScanCoordinator } from './scan-coordinator.js';

let observedLatest, automaticLatest;
let galleryIndexMemo;
let active = false, generating = false, epoch = 0, timer, fallback, observer;
const handlers = [], observations = new Map(), revisions = new Map();

export function generationBusy() {
    const stream = getSTContext()?.streamingProcessor;
    if (generating || (stream && !stream.isFinished && !stream.isStopped)) return true;
    const stop = document.querySelector('#mes_stop');
    return !!(stop && stop.getClientRects().length && getComputedStyle(stop).visibility !== 'hidden');
}

// ST's message data is authoritative; DOM text contains generated cards/buttons.
export function readSnapshot(messageId) {
    if (messageId == null || messageId === '') return null;
    const message = getSTContext()?.chat?.[Number(messageId)];
    if (!message || message.is_user || message.is_system || typeof message.mes !== 'string') return null;
    const source = message.mes, chatId = getChatId(), swipe = message.swipe_id ?? 0, mode = getActiveMode();
    if (!chatId) return null;
    const key = getMsgKey(chatId, messageId, source, swipe, mode), version = epoch;
    return { owner: chatId + ':' + messageId, chatId, messageId: String(messageId),
        source, swipe, mode, key, results: new Map(),
        isCurrent() {
            const current = getSTContext()?.chat?.[Number(messageId)];
            return active && settings.pluginOn !== false && epoch === version &&
                !generationBusy() && getChatId() === chatId &&
                current?.mes === source && (current.swipe_id ?? 0) === swipe && getActiveMode() === mode;
        } };
}
function latestAssistantId() {
    const chat = getSTContext()?.chat || [];
    for (let id = chat.length - 1; id >= 0; id--) {
        if (chat[id] && !chat[id].is_user && !chat[id].is_system) return id;
    }
    return -1;
}

function observeLatest() {
    const key = readSnapshot(latestAssistantId())?.key;
    if (key !== observedLatest) {
        observedLatest = key;
        automaticLatest = settings.autoGen === 1 ? key : undefined;
    }
}

export function resetAutomaticBacklog() {
    observedLatest = readSnapshot(latestAssistantId())?.key;
    automaticLatest = undefined;
}

export function messageRoot(id) {
    const message = Array.from(document.querySelectorAll('.mes')).find(n =>
        String(n.getAttribute('mesid') ?? n.getAttribute('data-mesid')) === String(id));
    const original = message?.querySelector('.mes_text');
    // TavernHelper teleports the streaming HTML into a sibling of the hidden original.
    return Array.from(original?.parentElement.children || []).find(node =>
        node !== original && node.matches('.TH-streaming,.mes_streaming') && !node.hidden) || original;
}

export function reanalyzeSlot({ id, source, origin, isCurrent, onSuccess, onError, onCancel, onSettled }) {
    const key = 'reanalyze:' + id;
    const existing = scanCoordinator.jobs.get(key);
    if (existing && ['running', 'queued'].includes(existing.state)) return;
    scanCoordinator.jobs.delete(key);
    return scanCoordinator.submit({
        owner: key, key, isCurrent,
        run: (current, signal) => runRosterPipeline(source, origin, { isCurrent: current, signal }),
        commit: result => onSuccess(result.enhanced),
        onError, onCancel, onSettled,
    });
}

function retryMessageSlot(snapshot, index, button) {
    if (!snapshot.isCurrent() || !settings.auxUrl || !settings.auxModel) return;
    const revision = prepareRevision(readSnapshot(snapshot.messageId));
    const slot = revision.slots[index];
    const token = tokenizePlaceholders(revision.source)[index];
    if (!token || !slot || !(slot.enhanced || snapshot.slots?.[index]?.enhanced)) return;
    button.disabled = true; button.textContent = '重新解析中…';
    const restore = label => { button.disabled = false; button.textContent = label; };
    const job = reanalyzeSlot({
        id: slot.id, source: token.text, origin: snapshot.messageId,
        isCurrent: () => revision.isCurrent() && revision.slots[index] === slot,
        onSuccess(enhanced) {
            // Keep the rest of a historical reply visible when reanalyzing under a different mode.
            for (const [i, previous] of (snapshot.slots || []).entries()) {
                if (i === index || revision.slots[i]?.enhanced || !previous.enhanced) continue;
                revision.slots[i] = { ...previous, mode: previous.mode || snapshot.mode };
                revision.results.set(i, { ok: true, enhanced: previous.enhanced });
            }
            const updated = { id: globalThis.crypto.randomUUID(), enhanced, skipSharedCache: true };
            revision.slots[index] = updated;
            revision.results.set(index, { ok: true, enhanced });
            saveImageRevision(revision);
            renderSnapshot(revision, null);
        },
        onError: () => restore('重新解析失败 · 重试'),
        onCancel: () => restore('重新解析'),
        onSettled: () => { if (button.disabled) restore('重新解析'); },
    });
    if (!job) restore('重新解析');
}

function renderMessageRoot(root, snapshot, enhanced, autoGenerate, resolvedOnly) {
    if (root.dataset.slRevision !== snapshot.key) {
        resetSlots(root);
        root.dataset.slRevision = snapshot.key;
    }
    return renderEnhancedLite(jQuery(root), enhanced, snapshot.key, snapshot.source, autoGenerate,
        (index, button) => retryMessageSlot(snapshot, index, button), resolvedOnly);
}
function renderSnapshot(snapshot, enhanced, autoGenerate = true, resolvedOnly = false) {
    const ids = snapshot.slots?.map(s => s.id);
    if (snapshot.slots) enhanced = snapshot.slots.map((slot, index) => slot.enhanced
        ? extractImgBlocksFromEnhanced(slot.enhanced, snapshot.key, index, ids, slot.mode || snapshot.mode)[0] : undefined);
    const root = messageRoot(snapshot.messageId);
    if (!root) return false;
    autoGenerate = autoGenerate && snapshot.key === automaticLatest && Number(snapshot.messageId) === latestAssistantId();
    let mounted = renderMessageRoot(root, snapshot, enhanced, autoGenerate, resolvedOnly);
    const visit = (node, depth = 0) => {
        if (depth > 3) return;
        for (const frame of node.querySelectorAll('iframe')) {
            try {
                const doc = frame.contentDocument;
                if (doc?.body) {
                    mounted = renderMessageRoot(doc.body, snapshot, enhanced, autoGenerate, resolvedOnly) || mounted;
                    visit(doc.body, depth + 1);
                }
            } catch { /* Cross-origin frames cannot be modified. */ }
        }
    };
    visit(root);
    return mounted;
}
export const scanCoordinator = new ScanCoordinator({
    run: (snapshot, isCurrent, signal) => snapshot.run ? snapshot.run(isCurrent, signal)
        : runRosterPipeline(snapshot.source, snapshot.messageId, { isCurrent, signal, results: snapshot.results,
            onSlot(index, enhanced) {
                if (!isCurrent()) return;
                snapshot.slots[index].enhanced = enhanced;
                saveImageRevision(snapshot);
                renderSnapshot(snapshot, null);
            } }),
    async commit(snapshot, result) {
        if (snapshot.commit) return snapshot.commit(result);
        saveImageRevision(snapshot);
        if (snapshot.isCurrent()) renderSnapshot(snapshot, result.enhanced);
    },
    onError(error, snapshot) {
        slErr('配图分析失败: ' + error.message);
        if (snapshot.onError) return snapshot.onError(error);
        messageRoot(snapshot.messageId)?.querySelectorAll('[role="status"][data-sl-slot]').forEach(slot => {
            slot.textContent = '🐱 分析失败，点击重试'; slot.classList.add('sl_scan_retry'); slot.style.cursor = 'pointer';
        });
    },
    onCancel(snapshot) {
        if (snapshot.onCancel) return snapshot.onCancel();
        messageRoot(snapshot.messageId)?.querySelectorAll('[role="status"][data-sl-slot]').forEach(slot => {
            slot.textContent = '🐱 分析已取消，点击继续'; slot.classList.add('sl_scan_retry'); slot.style.cursor = 'pointer';
        });
    }
});
export function saveImageRevision(snapshot) {
    const session = sessionData(snapshot.chatId, true);
    if (!session) return;
    session.revisions[snapshot.key] = {
        source: snapshot.source, messageId: snapshot.messageId, swipe: snapshot.swipe,
        mode: snapshot.mode, slots: structuredClone(snapshot.slots), ts: Date.now(),
    };
    void saveArchive();
}

function cacheReuse(chatId, mode) {
    const source = galleryCacheSource(chatId);
    if (!source) return null;
    const session = sessionData(source);
    let index;
    return snapshot => {
        const job = scanCoordinator.jobs.get(snapshot.key);
        const canReuse = slot => !slot.skipSharedCache && !imgCacheGetById(slot.id, chatId) && !isImagePending(slot.id);
        if (job && ['queued', 'running'].includes(job.state)) return false;
        if (!snapshot.slots.some(canReuse)) return false;
        if (!index) {
            const records = Object.values(session.revisions);
            const urls = Object.keys(session.gallery);
            const memo = galleryIndexMemo;
            if (memo?.source === source && memo.mode === mode && memo.images === session.images && urls.length === memo.urls.size &&
                urls.every(url => memo.urls.has(url)) && records.length === memo.records.length &&
                records.every((record, i) => record === memo.records[i])) index = memo.index;
            else {
                index = indexGalleryRecords(records, session, mode);
                galleryIndexMemo = { source, mode, index, records, images: session.images, urls: new Set(urls) };
            }
        }
        let reused = false;
        for (const token of markerOccurrences(snapshot.source)) {
            const slot = snapshot.slots[token.index];
            if (!canReuse(slot)) continue;
            const hit = index.get(token.occurrence);
            if (!hit) continue;
            slot.enhanced = hit.enhanced;
            snapshot.results.set(token.index, { ok: true, enhanced: hit.enhanced });
            galleryAdd(hit.url, { chatKey: chatId, blockId: slot.id, scene: token.content.split('|')[0] });
            reused = true;
        }
        if (reused) saveImageRevision(snapshot);
        return reused;
    };
}

function indexGalleryRecords(records, session, mode) {
    const index = new Map();
    for (const record of records.slice().sort((a, b) => b.ts - a.ts)) {
        for (const token of markerOccurrences(record.source)) {
            const slot = record.slots[token.index];
            if (!slot?.enhanced || (slot.mode || record.mode) !== mode) continue;
            const url = session.images[slot.id];
            if (!url || session.gallery[url]?.kind !== 'chat') continue;
            if (!index.has(token.occurrence)) index.set(token.occurrence, { enhanced: slot.enhanced, url });
        }
    }
    return index;
}

export function reuseGalleryImages(snapshot) {
    return cacheReuse(snapshot.chatId, snapshot.mode)?.(snapshot);
}

function* markerOccurrences(source) {
    const counts = new Map();
    for (const token of tokenizePlaceholders(source)) {
        const prior = counts.get(token.text) || 0;
        counts.set(token.text, prior + 1);
        yield { ...token, occurrence: JSON.stringify([token.text, prior]) };
    }
}

function prepareRevision(snapshot) {
    const owner = JSON.stringify([snapshot.chatId, snapshot.messageId, snapshot.swipe, snapshot.mode]);
    let previous = revisions.get(owner);
    if (previous?.key === snapshot.key) {
        snapshot.slots = previous.slots; snapshot.results = previous.results;
        revisions.set(owner, snapshot); return snapshot;
    }
    const saved = sessionData(snapshot.chatId)?.revisions || {};
    previous = saved[snapshot.key] || previous;
    if (!previous) previous = Object.values(saved).filter(record => record.messageId === snapshot.messageId &&
        record.swipe === snapshot.swipe && record.mode === snapshot.mode).sort((a, b) => b.ts - a.ts)[0];
    snapshot.slots = reconcileSlots(snapshot.source, snapshot.key, previous);
    for (const [i, slot] of snapshot.slots.entries()) if (slot.enhanced) snapshot.results.set(i, { ok: true, enhanced: slot.enhanced });
    revisions.delete(owner); revisions.set(owner, snapshot);
    if (revisions.size > 200) revisions.delete(revisions.keys().next().value);
    return snapshot;
}
export function getMsgKey(chatId, messageId, source, swipe = 0, mode = getActiveMode()) {
    return messageKey(chatId, messageId, source, swipe, mode);
}

function findBestCachedEntry(chatId, messageId, source, swipe, mode = getActiveMode()) {
    const key = getMsgKey(chatId, messageId, source, swipe, mode);
    const record = sessionData(chatId)?.revisions[key];
    if (record?.source !== source) return null;
    return { ...record, key, complete: record.slots.every(slot => slot.enhanced) };
}

export function clearMsgCache(chatId, messageId) {
    const session = sessionData(chatId);
    const id = String(messageId);
    if (session) {
        const removed = new Set();
        for (const [key, revision] of Object.entries(session.revisions)) {
            if (revision.messageId !== id) continue;
            for (const slot of revision.slots) removed.add(slot.id);
            delete session.revisions[key];
        }
        for (const revision of Object.values(session.revisions)) for (const slot of revision.slots) removed.delete(slot.id);
        if (removed.size) {
            const images = { ...session.images };
            for (const slotId of removed) delete images[slotId];
            session.images = images;
        }
        if (removed.size) void saveArchive();
    }
    for (const [owner, revision] of revisions) if (revision.chatId === chatId && revision.messageId === id) revisions.delete(owner);
}
export function scanAllMsgs() {
    if (!active || settings.pluginOn === false || generationBusy()) return;
    observeLatest();
    const latest = latestAssistantId();
    const reuse = cacheReuse(getChatId(), getActiveMode());
    for (const el of document.querySelectorAll('.mes')) {
        const id = el.getAttribute('mesid') ?? el.getAttribute('data-mesid'), snapshot = readSnapshot(id);
        if (!snapshot) continue;
        const cached = findBestCachedEntry(snapshot.chatId, id, snapshot.source, snapshot.swipe);
        const revision = cached || (reuse && tokenizePlaceholders(snapshot.source).length) ? prepareRevision(snapshot) : null;
        const reused = revision && reuse?.(revision);
        if (cached || reused) renderSnapshot(revision, null, Number(id) === latest, Number(id) !== latest);
        else if (Number(id) !== latest) {
            const saved = sessionData(snapshot.chatId)?.revisions || {};
            const historical = Object.entries(saved)
                .filter(([, record]) => record.messageId === snapshot.messageId && record.swipe === snapshot.swipe &&
                    record.source === snapshot.source && record.slots.some(slot => slot.enhanced))
                .sort(([, a], [, b]) => b.ts - a.ts)[0];
            if (historical) {
                const [key, record] = historical;
                renderSnapshot({ ...snapshot, key, mode: record.mode, slots: record.slots }, null, false, true);
            }
        }
    }
}
export function checkLastMessage() {
    if (!active || settings.pluginOn === false || generationBusy() || document.querySelector('.edit_textarea,#curEditTextarea')) return;
    const id = latestAssistantId();
    observeLatest();
    if (id >= 0) scheduleMessage(id);
}
function scheduleMessage(id, immediate = false) {
    let snapshot = readSnapshot(id);
    if (!snapshot || !snapshot.isCurrent()) return;
    const tokens = tokenizePlaceholders(snapshot.source);
    if (!tokens.length) {
        const root = messageRoot(id);
        if (root && root.dataset.slRevision !== snapshot.key) {
            resetSlots(root);
            root.dataset.slRevision = snapshot.key;
        }
        prepareRevision(snapshot);
        return;
    }
    const cache = findBestCachedEntry(snapshot.chatId, id, snapshot.source, snapshot.swipe);
    if (cache?.complete) { renderSnapshot(prepareRevision(snapshot), null); return; }
    if (!settings.cWf || !settings.auxUrl || !settings.auxModel) return;
    const observation = observations.get(snapshot.owner);
    if (!observation || observation.key !== snapshot.key) {
        observations.set(snapshot.owner, { key: snapshot.key, since: Date.now() });
        if (!immediate) { requestCheck(800); return; }
    } else if (!immediate && Date.now() - observation.since < 700) { requestCheck(800); return; }
    snapshot = prepareRevision(snapshot);
    reuseGalleryImages(snapshot);
    if (!renderSnapshot(snapshot, null) || snapshot.slots.every(slot => slot.enhanced)) return;
    saveImageRevision(snapshot);
    const job = scanCoordinator.submit(snapshot);
    if (job?.state === 'cancelled') scanCoordinator.onCancel(snapshot);
}
export function cancelPendingScans() {
    const latest = readSnapshot(latestAssistantId());
    return scanCoordinator.cancelPending(latest?.isCurrent() && tokenizePlaceholders(latest.source).length &&
        !findBestCachedEntry(latest.chatId, latest.messageId, latest.source, latest.swipe)?.complete ? [latest] : []);
}
export async function runAuxImageScan(element) {
    if (generationBusy()) return;
    const id = element?.closest('.mes').attr('mesid') ?? element?.closest('.mes').attr('data-mesid') ?? latestAssistantId();
    const snapshot = readSnapshot(id);
    if (snapshot) {
        const job = scanCoordinator.jobs.get(snapshot.key);
        if (job?.state === 'running' || job?.state === 'queued') return;
        scanCoordinator.jobs.delete(snapshot.key);
    }
    observeLatest();
    scheduleMessage(id, true);
}
function requestCheck(delay = 150) {
    clearTimeout(timer); timer = setTimeout(() => { scanAllMsgs(); checkLastMessage(); }, delay);
}
export function startPolling() {
    if (active) return;
    active = true;
    resetAutomaticBacklog();
    const ctx = getSTContext(), source = ctx?.eventSource, types = ctx?.event_types || ctx?.eventTypes;
    const on = (name, fn) => {
        if (!types?.[name] || !source?.on) return;
        source.on(types[name], fn); handlers.push(() => (source.off || source.removeListener)?.call(source, types[name], fn));
    };
    on('GENERATION_STARTED', (_type, _options, dryRun) => {
        if (dryRun) return;
        generating = true; epoch++; scanCoordinator.clear(); clearTimeout(timer);
    });
    for (const name of ['GENERATION_ENDED', 'GENERATION_STOPPED']) on(name, () => { generating = false; requestCheck(300); });
    for (const name of ['MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'CHARACTER_MESSAGE_RENDERED', 'MESSAGE_DELETED']) on(name, () => requestCheck());
    for (const name of ['MESSAGE_EDITED', 'MESSAGE_SWIPED']) on(name, id => {
        requestCheck(); setTimeout(() => { if (active) scheduleMessage(id); }, 850);
    });
    on('CHAT_CHANGED', () => { epoch++; generating = false; observations.clear(); revisions.clear(); scanCoordinator.clear(); resetAutomaticBacklog(); refreshCoopCards(); requestCheck(500); });
    observer = new MutationObserver(mutations => {
        if (mutations.every(m => (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest?.('[data-sl-slot],.sl_img_block'))) return;
        requestCheck(250);
    });
    const chatRoot = document.querySelector('#chat');
    if (chatRoot) { observer.observe(chatRoot, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] }); chatRoot.addEventListener('load', onFrameLoad, true); }
    jQuery(document).off('click.slScan', '.sl_scan_retry').on('click.slScan', '.sl_scan_retry', function () { runAuxImageScan(jQuery(this).closest('.mes_text')); });
    fallback = setInterval(() => requestCheck(), 3000); requestCheck(500);
    slLog('占位符扫描器已启动');
}
function onFrameLoad() { requestCheck(200); }
export function stopPolling() {
    active = false; epoch++; generating = false; clearTimeout(timer); clearInterval(fallback); observer?.disconnect();
    document.querySelector('#chat')?.removeEventListener('load', onFrameLoad, true);
    handlers.splice(0).forEach(off => off()); observations.clear(); revisions.clear(); scanCoordinator.clear(); jQuery(document).off('click.slScan');
}
export function getScannerStatus() {
    if (settings.pluginOn === false) return 'off';
    if (generationBusy()) return 'waiting_end';
    return scanCoordinator.running ? 'scanning' : 'idle';
}
