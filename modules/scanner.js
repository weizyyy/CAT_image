import { slLog, slErr } from './log.js';
import { settings, getSTContext } from './settings.js';
import { getProfiles, getChatId } from './pipeline/profile.js';
import { runRosterPipeline } from './pipeline/roster-pipeline.js';
import { refreshCoopCards } from './sync-cards.js';
import { imgStorePut, imgStoreDeletePrefix } from './imgstore.js';
import { renderEnhancedLite, extractImgBlocksFromEnhanced, setRestoreDeps } from './render.js';
import { fingerprint, messageKey, tokenizePlaceholders } from './placeholders.js';
import { resetSlots } from './dom-placeholders.js';
import { ScanCoordinator } from './scan-coordinator.js';

let active = false, generating = false, epoch = 0, timer, fallback, observer;
const handlers = [], observations = new Map();
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
    const source = message.mes, chatId = getChatId(), swipe = message.swipe_id ?? 0;
    const key = messageKey(chatId, messageId, source, swipe), version = epoch;
    return { owner: chatId + ':' + messageId, chatId, messageId: String(messageId),
        source, swipe, key, results: new Map(),
        isCurrent() {
            const current = getSTContext()?.chat?.[Number(messageId)];
            return active && settings.pluginOn !== false && epoch === version &&
                !generationBusy() && getChatId() === chatId &&
                current?.mes === source && (current.swipe_id ?? 0) === swipe;
        } };
}
export function messageRoot(id) {
    return Array.from(document.querySelectorAll('.mes')).find(n =>
        String(n.getAttribute('mesid') ?? n.getAttribute('data-mesid')) === String(id))?.querySelector('.mes_text');
}
function renderSnapshot(snapshot, enhanced) {
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
                snapshot.blocks ||= [];
                snapshot.blocks[index] = extractImgBlocksFromEnhanced(enhanced, snapshot.key, index)[0];
                renderSnapshot(snapshot, snapshot.blocks);
            } }),
    async commit(snapshot, result) {
        if (snapshot.commit) return snapshot.commit(result);
        await imgStorePut(snapshot.key, JSON.stringify({ version: 2, source: snapshot.source,
            swipe: snapshot.swipe, enhanced: result.enhanced }), Date.now());
        if (snapshot.isCurrent()) renderSnapshot(snapshot, result.enhanced);
    },
    onError(error, snapshot) {
        slErr('配图分析失败: ' + error.message);
        if (snapshot.onError) snapshot.onError(error);
        messageRoot(snapshot.messageId)?.querySelectorAll('[role="status"][data-sl-slot]').forEach(slot => {
            slot.textContent = '🐱 分析失败，点击重试'; slot.classList.add('sl_scan_retry'); slot.style.cursor = 'pointer';
        });
    }
});
export function getMsgFingerprint(text) { return fingerprint(text); }
export function getMsgKey(chid, mesid, text, swipe = 0) { return messageKey(chid, mesid, text, swipe); }
export function findBestCachedEntry(chid, mesid, text, swipe = 0) {
    const key = getMsgKey(chid, mesid, text, swipe), raw = settings.msgMap?.[key];
    if (!raw) return null;
    try {
        const record = JSON.parse(raw);
        if (record.version === 2 && record.source === text && record.swipe === swipe) return { key, value: record.enhanced };
    } catch { /* Old prefix caches cannot safely be attributed to a swipe. */ }
    return null;
}
export function findBestCached(chid, mesid, text, swipe = 0) { return findBestCachedEntry(chid, mesid, text, swipe)?.value || null; }
export function clearMsgCache(chid, mesid) {
    const prefix = chid + '_' + mesid + '_';
    for (const key of Object.keys(settings.msgMap || {})) if (key.startsWith(prefix)) delete settings.msgMap[key];
    imgStoreDeletePrefix(prefix);
}
export function scanAllMsgs() {
    if (!active || settings.pluginOn === false || generationBusy()) return;
    for (const el of document.querySelectorAll('.mes')) {
        const id = el.getAttribute('mesid') ?? el.getAttribute('data-mesid'), snapshot = readSnapshot(id);
        if (!snapshot) continue;
        const cached = findBestCachedEntry(snapshot.chatId, id, snapshot.source, snapshot.swipe);
        if (cached) renderSnapshot(snapshot, cached.value);
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
    const snapshot = readSnapshot(id);
    if (!snapshot || !snapshot.isCurrent()) return;
    const root = messageRoot(id);
    if (root && root.dataset.slRevision !== snapshot.key) {
        resetSlots(root); root.querySelectorAll('.sl_img_block').forEach(n => n.remove()); root.dataset.slRevision = snapshot.key;
    }
    if (!tokenizePlaceholders(snapshot.source).length) return;
    const cache = findBestCachedEntry(snapshot.chatId, id, snapshot.source, snapshot.swipe);
    if (cache) { renderSnapshot(snapshot, cache.value); return; }
    if (!settings.cWf || !settings.auxUrl || !settings.auxModel) return;
    const observation = observations.get(snapshot.owner);
    if (!observation || observation.key !== snapshot.key) {
        observations.set(snapshot.owner, { key: snapshot.key, since: Date.now() });
        if (!immediate) { requestCheck(800); return; }
    } else if (!immediate && Date.now() - observation.since < 700) { requestCheck(800); return; }
    if (!renderSnapshot(snapshot, null)) return;
    scanCoordinator.submit(snapshot);
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
    on('CHAT_CHANGED', () => { epoch++; generating = false; observations.clear(); scanCoordinator.clear(); refreshCoopCards(); requestCheck(500); });
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
    handlers.splice(0).forEach(off => off()); observations.clear(); scanCoordinator.clear(); jQuery(document).off('click.slScan');
}
export function hasCastCache() { const pf = getProfiles(); return !!(pf && Object.keys(pf.root[pf.charName].cast || {}).length); }
export function getScannerStatus() {
    if (settings.pluginOn === false) return 'off';
    if (generationBusy()) return 'waiting_end';
    return scanCoordinator.running ? 'scanning' : 'idle';
}
