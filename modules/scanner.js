import { slLog, slErr } from './log.js';
import { settings, getSTContext, getActiveMode } from './settings.js';
import { getProfiles, getChatId } from './pipeline/profile.js';
import { runRosterPipeline } from './pipeline/roster-pipeline.js';
import { refreshCoopCards } from './sync-cards.js';
import { imgStorePut, imgStoreDeletePrefix } from './imgstore.js';
import { renderEnhancedLite, extractImgBlocksFromEnhanced, setRestoreDeps } from './render.js';
import { fingerprint, messageKey, tokenizePlaceholders, replaceTokens } from './placeholders.js';
import { reconcileSlots } from './slot-revisions.js';
import { resetSlots } from './dom-placeholders.js';
import { ScanCoordinator } from './scan-coordinator.js';

let active = false, generating = false, epoch = 0, timer, fallback, observer;
const handlers = [], observations = new Map(), revisions = new Map();
setRestoreDeps(getChatId, getSTContext);

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
export function messageRoot(id) {
    return Array.from(document.querySelectorAll('.mes')).find(n =>
        String(n.getAttribute('mesid') ?? n.getAttribute('data-mesid')) === String(id))?.querySelector('.mes_text');
}
function renderSnapshot(snapshot, enhanced) {
    const ids = snapshot.slots?.map(s => s.id);
    if (snapshot.slots) enhanced = snapshot.slots.map((slot, index) => slot.enhanced
        ? extractImgBlocksFromEnhanced(slot.enhanced, snapshot.key, index, ids)[0] : undefined);
    const root = messageRoot(snapshot.messageId);
    if (!root) return false;
    let mounted = renderEnhancedLite(jQuery(root), enhanced, snapshot.key, snapshot.source);
    if (settings.feBridge === false) return mounted;
    const visit = (node, depth = 0) => {
        if (depth > 3) return;
        for (const frame of node.querySelectorAll('iframe')) {
            try {
                const doc = frame.contentDocument;
                if (doc?.body) {
                    mounted = renderEnhancedLite(jQuery(doc.body), enhanced, snapshot.key, snapshot.source) || mounted;
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
                saveRevision(snapshot);
                renderSnapshot(snapshot, null);
            } }),
    async commit(snapshot, result) {
        if (snapshot.commit) return snapshot.commit(result);
        saveRevision(snapshot);
        if (snapshot.isCurrent()) renderSnapshot(snapshot, result.enhanced);
    },
    onError(error, snapshot) {
        slErr('配图分析失败: ' + error.message);
        if (snapshot.onError) snapshot.onError(error);
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
function saveRevision(snapshot) {
    const values = snapshot.slots.map(s => s.enhanced);
    imgStorePut(snapshot.key, JSON.stringify({ version: 3, source: snapshot.source, swipe: snapshot.swipe, mode: snapshot.mode,
        slots: snapshot.slots, enhanced: replaceTokens(snapshot.source, tokenizePlaceholders(snapshot.source), values) }), Date.now());
}
function readRecord(key, mode = getActiveMode()) {
    try {
        const record = JSON.parse(settings.msgMap?.[key]);
        if (![2, 3].includes(record.version) || typeof record.source !== 'string') return null;
        if ((mode === 'minimax_h3_image') !== (record.mode === 'minimax_h3_image')) return null;
        const tokens = tokenizePlaceholders(record.source);
        if (record.version === 2) {
            const values = Array.from(String(record.enhanced || '').matchAll(/\[image:\s*[\s\S]*?\]\s*【提示词】[\s\S]*?【\/提示词】/g), m => m[0]);
            if (values.length !== tokens.length) return null;
            record.slots = values.map((enhanced, i) => ({ id: key + '#' + i, enhanced }));
        }
        if (!Array.isArray(record.slots) || record.slots.length !== tokens.length || record.slots.some(s => !s || typeof s.id !== 'string')) return null;
        return record;
    } catch { return null; }
}
function prepareRevision(snapshot) {
    const owner = JSON.stringify([snapshot.chatId, snapshot.messageId, snapshot.swipe, snapshot.mode]);
    let previous = revisions.get(owner);
    if (previous?.key === snapshot.key) {
        snapshot.slots = previous.slots; snapshot.results = previous.results;
        revisions.set(owner, snapshot); return snapshot;
    }
    previous = readRecord(snapshot.key, snapshot.mode) || previous;
    if (!previous) {
        const prefix = snapshot.chatId + '_' + snapshot.messageId + '_v2_' + snapshot.swipe + '_';
        const keys = Object.keys(settings.msgMap || {}).filter(k => k.startsWith(prefix))
            .sort((a, b) => (settings.msgMapTs?.[b] || 0) - (settings.msgMapTs?.[a] || 0));
        for (const key of keys) { previous = readRecord(key, snapshot.mode); if (previous) break; }
    }
    snapshot.slots = reconcileSlots(snapshot.source, snapshot.key, previous);
    for (const [i, slot] of snapshot.slots.entries()) if (slot.enhanced) snapshot.results.set(i, { ok: true, enhanced: slot.enhanced });
    revisions.delete(owner); revisions.set(owner, snapshot);
    if (revisions.size > 200) revisions.delete(revisions.keys().next().value);
    return snapshot;
}
export function getMsgFingerprint(text) { return fingerprint(text); }
export function getMsgKey(chid, mesid, text, swipe = 0, mode = getActiveMode()) {
    // Preserve existing cache IDs; the new mode gets its own prompt/image lineage.
    return messageKey(chid, mesid, text, swipe) + (mode === 'minimax_h3_image' ? '_minimax_h3_image' : '');
}
export function findBestCachedEntry(chid, mesid, text, swipe = 0) {
    const key = getMsgKey(chid, mesid, text, swipe), record = readRecord(key);
    if (record?.source === text && record.swipe === swipe)
        return { key, value: record.enhanced, slots: record.slots, complete: record.slots.every(s => s.enhanced) };
    return null;
}
export function findBestCached(chid, mesid, text, swipe = 0) { return findBestCachedEntry(chid, mesid, text, swipe)?.value || null; }
export function clearMsgCache(chid, mesid) {
    const prefix = chid + '_' + mesid + '_';
    for (const key of Object.keys(settings.msgMap || {})) if (key.startsWith(prefix)) delete settings.msgMap[key];
    imgStoreDeletePrefix(prefix);
    for (const [owner, revision] of revisions) if (revision.chatId === chid && revision.messageId === String(mesid)) revisions.delete(owner);
}
export function scanAllMsgs() {
    if (!active || settings.pluginOn === false || generationBusy()) return;
    for (const el of document.querySelectorAll('.mes')) {
        const id = el.getAttribute('mesid') ?? el.getAttribute('data-mesid'), snapshot = readSnapshot(id);
        if (!snapshot) continue;
        const cached = findBestCachedEntry(snapshot.chatId, id, snapshot.source, snapshot.swipe);
        if (cached) renderSnapshot(prepareRevision(snapshot), cached.value);
    }
}
export function checkLastMessage() {
    if (!active || settings.pluginOn === false || generationBusy() || document.querySelector('.edit_textarea,#curEditTextarea')) return;
    const chat = getSTContext()?.chat || [];
    let id = chat.length - 1;
    while (id >= 0 && (chat[id].is_user || chat[id].is_system)) id--;
    if (id >= 0) scheduleMessage(id);
}
function scheduleMessage(id, immediate = false) {
    let snapshot = readSnapshot(id);
    if (!snapshot || !snapshot.isCurrent()) return;
    const root = messageRoot(id);
    if (root && root.dataset.slRevision !== snapshot.key) {
        resetSlots(root); root.querySelectorAll('.sl_img_block').forEach(n => n.remove()); root.dataset.slRevision = snapshot.key;
    }
    if (!tokenizePlaceholders(snapshot.source).length) { prepareRevision(snapshot); return; }
    const cache = findBestCachedEntry(snapshot.chatId, id, snapshot.source, snapshot.swipe);
    if (cache?.complete) { renderSnapshot(prepareRevision(snapshot), cache.value); return; }
    if (!settings.cWf || !settings.auxUrl || !settings.auxModel) return;
    const observation = observations.get(snapshot.owner);
    if (!observation || observation.key !== snapshot.key) {
        observations.set(snapshot.owner, { key: snapshot.key, since: Date.now() });
        if (!immediate) { requestCheck(800); return; }
    } else if (!immediate && Date.now() - observation.since < 700) { requestCheck(800); return; }
    snapshot = prepareRevision(snapshot);
    if (!renderSnapshot(snapshot, null)) return;
    saveRevision(snapshot);
    const job = scanCoordinator.submit(snapshot);
    if (job?.state === 'cancelled') scanCoordinator.onCancel(snapshot);
}
export function cancelPendingScans() {
    const chat = getSTContext()?.chat || [];
    let id = chat.length - 1;
    while (id >= 0 && (chat[id].is_user || chat[id].is_system)) id--;
    const latest = readSnapshot(id);
    return scanCoordinator.cancelPending(latest?.isCurrent() && tokenizePlaceholders(latest.source).length &&
        !findBestCachedEntry(latest.chatId, id, latest.source, latest.swipe)?.complete ? [latest] : []);
}
export async function runAuxImageScan(element) {
    if (generationBusy()) return;
    const id = element?.closest('.mes').attr('mesid') ?? (getSTContext()?.chat?.length - 1);
    const snapshot = readSnapshot(id);
    if (snapshot) {
        const job = scanCoordinator.jobs.get(snapshot.key);
        if (job?.state === 'running' || job?.state === 'queued') return;
        scanCoordinator.jobs.delete(snapshot.key);
    }
    scheduleMessage(id, true);
}
function requestCheck(delay = 150) {
    clearTimeout(timer); timer = setTimeout(() => { scanAllMsgs(); checkLastMessage(); }, delay);
}
export function startPolling() {
    if (active) return;
    active = true;
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
    on('CHAT_CHANGED', () => { epoch++; generating = false; observations.clear(); revisions.clear(); scanCoordinator.clear(); refreshCoopCards(); requestCheck(500); });
    observer = new MutationObserver(mutations => {
        if (mutations.every(m => (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest?.('[data-sl-slot],.sl_img_block'))) return;
        requestCheck(250);
    });
    const chatRoot = document.querySelector('#chat');
    if (chatRoot) { observer.observe(chatRoot, { subtree: true, childList: true, characterData: true }); chatRoot.addEventListener('load', onFrameLoad, true); }
    jQuery(document).off('click.slScan', '.sl_scan_retry').on('click.slScan', '.sl_scan_retry', function () { runAuxImageScan(jQuery(this).closest('.mes_text')); });
    fallback = setInterval(() => requestCheck(), 3000); requestCheck(500);
    slLog('扫描器 v2：完整回复版本 + 生成生命周期 + 独立图位');
}
function onFrameLoad() { requestCheck(200); }
export function stopPolling() {
    active = false; epoch++; generating = false; clearTimeout(timer); clearInterval(fallback); observer?.disconnect();
    document.querySelector('#chat')?.removeEventListener('load', onFrameLoad, true);
    handlers.splice(0).forEach(off => off()); observations.clear(); revisions.clear(); scanCoordinator.clear(); jQuery(document).off('click.slScan');
}
export function hasCastCache() { const pf = getProfiles(); return !!(pf && Object.keys(pf.root[pf.charName].cast || {}).length); }
export function getScannerStatus() {
    if (settings.pluginOn === false) return 'off';
    if (generationBusy()) return 'waiting_end';
    return scanCoordinator.running ? 'scanning' : 'idle';
}
