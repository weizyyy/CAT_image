// Frontend replies use the same scheduler and DOM slots as normal chat messages.
// No property traps, global first-iframe target, pending-turn overwrite or tail append.
import { settings, getSTContext, getActiveMode, isAuxConfigured } from './settings.js';
import { slLog, slErr } from './log.js';
import { getChatId } from './archive.js';
import { runRosterPipeline } from './pipeline/roster-pipeline.js';
import { scanCoordinator, generationBusy, reanalyzeSlot, getMsgKey, reuseGalleryImages, saveImageRevision } from './scanner.js';
import { renderEnhancedLite, extractImgBlocksFromEnhanced, buildImgCard, bindImageButtonsIn } from './render.js';
import { fingerprint, tokenizePlaceholders, replaceTokens } from './placeholders.js';
import { locateMarkers } from './dom-placeholders.js';
import { getPrompt } from '../prompts/loader.js';

let running = false, timer, serial = 0, chatId = '', observer;
const hooks = [], records = new Map(), frameIds = new WeakMap();
const rootOwners = new WeakMap(), inflight = new WeakMap(), latestCalls = new WeakMap(), holdUntil = new WeakMap();
let frameSerial = 0, autoAfterCall = 0, newestRecord;

export function resetFrontendAutomaticBacklog() { autoAfterCall = serial; }

function eachWindow(fn, win = window, depth = 0) {
    if (depth > 4) return;
    try {
        fn(win);
        for (const frame of win.document.querySelectorAll('iframe')) {
            try { if (frame.contentDocument?.body) eachWindow(fn, frame.contentWindow, depth + 1); } catch { /* opaque origin */ }
        }
    } catch { /* frame navigated */ }
}

export function extractNarrativeText(raw, depth = 0) {
    if (depth > 6 || raw == null) return '';
    if (typeof raw === 'string') {
        const text = raw.trim().replace(/^```[\w-]*\s*\n?/, '').replace(/\n?```$/, '');
        try { return extractNarrativeText(JSON.parse(text), depth + 1); } catch { return text; }
    }
    if (Array.isArray(raw)) return raw.map(v => extractNarrativeText(v, depth + 1)).filter(Boolean).join('\n');
    if (typeof raw !== 'object') return '';
    for (const key of ['narrative', 'content', 'text', 'message', 'data', 'response']) {
        const text = extractNarrativeText(raw[key], depth + 1);
        if (tokenizePlaceholders(text).length) return text;
    }
    const texts = [];
    for (const call of raw.tool_calls || raw.toolCalls || []) {
        const text = extractNarrativeText((call.function || call).arguments, depth + 1);
        if (text) texts.push(text);
    }
    return texts.join('\n');
}
function sceneCall(params) {
    const name = params?.json_schema?.name || params?.response_format?.json_schema?.name || '';
    return !/(summary|digest|archive|recap|state|extract|analysis|rating)/i.test(name);
}
function frameId(win) {
    if (!frameIds.has(win)) frameIds.set(win, ++frameSerial);
    return frameIds.get(win);
}
function findTarget(win, text) {
    const tokens = tokenizePlaceholders(text);
    if (!tokens.length) return null;
    const find = w => {
        const doc = w.document;
        const candidates = Array.from(doc.querySelectorAll('.msg-narrator,.narrative-area,#narrativeArea,.message-content,.mes_text')).reverse();
        candidates.push(doc.body);
        for (const root of candidates) {
            if (!root) continue;
            const markers = locateMarkers(root);
            // Require the full marker sequence. Never borrow an old unmatched marker.
            if (markers.length !== tokens.length) continue;
            const norm = s => s.replace(/<[^>]*>/g, '').replace(/[*`\s]/g, '');
            if (markers.every((m, i) => norm(m.content) === norm(tokens[i].content)) && norm(root.textContent).includes(norm(text))) return root;
        }
        return null;
    };
    try {
        const own = find(win);
        if (win !== window) return own;
        // Top-level helper calls can originate in an iframe: match exact content.
        const found = [];
        eachWindow(w => { if (w !== window) { const root = find(w); if (root) found.push(root); } });
        return found.length === 1 ? found[0] : own;
    } catch { return null; }
}
function visibleRecord(record) {
    try {
        return record.root?.isConnected && record.root.ownerDocument.defaultView?.frameElement?.isConnected !== false &&
            (Array.from(record.root.querySelectorAll('[data-sl-slot]')).some(n => n.dataset.slSlot.startsWith(record.key + '#')) ||
                findTarget(record.win, record.text) === record.root);
    } catch { return false; }
}
function renderRecord(record) {
    const ids = record.slots.map(slot => slot.id);
    const blocks = record.slots.map((slot, index) => slot.enhanced && extractImgBlocksFromEnhanced(
        slot.enhanced, record.key, index, ids, record.mode)[0]);
    return renderEnhancedLite(jQuery(record.root), blocks, record.key, record.text, {
        autoGenerate: !generationBusy() && record === newestRecord && record.callId > autoAfterCall && record.autoEligible,
        onReanalyze: (index, button) => retryFrontendSlot(record, index, button),
    });
}

function retryFrontendSlot(record, index, button) {
    const token = tokenizePlaceholders(record.text)[index];
    const block = record.slots[index];
    if (!token || !block?.enhanced || !record.enhanced || !isAuxConfigured()) return;
    const restore = label => { button.disabled = false; button.textContent = label; };
    button.disabled = true; button.textContent = '重新解析中…';
    const job = reanalyzeSlot({
        id: block.id, source: token.text, origin: record.key,
        isCurrent: () => running && settings.feBridge !== false && settings.pluginOn !== false &&
            getChatId() === record.chatId && getActiveMode() === record.mode &&
            rootOwners.get(record.root) === record.key && !inflight.get(record.win) && visibleRecord(record) &&
            record.slots[index] === block,
        onSuccess(enhanced) {
            record.results.set(index, { ok: true, enhanced });
            record.slots[index] = { id: globalThis.crypto.randomUUID(), enhanced, skipSharedCache: true };
            record.enhanced = replaceTokens(record.text, tokenizePlaceholders(record.text), record.slots.map(slot => slot.enhanced));
            saveImageRevision(record);
            renderRecord(record);
        },
        onError: () => restore('重新解析失败 · 重试'),
        onCancel: () => restore('重新解析'),
        onSettled: () => { if (button.disabled) restore('重新解析'); },
    });
    if (!job) restore('重新解析');
}

function submitRecord(record) {
    if (record.cancelled) return;
    if (record.mode !== getActiveMode()) return;
    if (generationBusy() || settings.pluginOn === false) return;
    if (inflight.get(record.win)) return;
    if (record.callId !== latestCalls.get(record.win) && (holdUntil.get(record.win) || 0) > Date.now()) return;
    if (record.root && rootOwners.get(record.root) !== record.key) return;
    if (!record.root?.isConnected) {
        record.root = findTarget(record.win, record.text);
        if (record.root) rootOwners.set(record.root, record.key);
    }
    if (!record.root) return;
    if (reuseGalleryImages(record) && record.slots.every(slot => slot.enhanced))
        record.enhanced = replaceTokens(record.text, tokenizePlaceholders(record.text), record.slots.map(slot => slot.enhanced));
    renderRecord(record);
    if (record.enhanced || !isAuxConfigured()) return;
    scanCoordinator.submit({ owner: record.key, key: record.key, source: record.text,
        isCurrent: () => running && settings.feBridge !== false && settings.pluginOn !== false &&
            getChatId() === record.chatId && getActiveMode() === record.mode && !generationBusy() && !inflight.get(record.win) &&
            rootOwners.get(record.root) === record.key && visibleRecord(record),
        run: (isCurrent, signal) => runRosterPipeline(record.text, record.key, { isCurrent, signal, results: record.results,
            onSlot(index, enhanced) {
                if (!isCurrent()) return;
                record.slots[index].enhanced = enhanced;
                saveImageRevision(record);
                renderRecord(record);
            } }),
        commit(result) {
            record.enhanced = result.enhanced;
            renderRecord(record);
        },
        onError(error) {
            record.root.querySelectorAll('[role="status"][data-sl-slot]').forEach(node => {
                if (error.retryable !== false) { node.textContent = '🐱 分析失败，稍后重试'; return; }
                node.textContent = '🐱 分析失败，点击重试';
                node.style.cursor = 'pointer';
                node.onclick = () => { scanCoordinator.jobs.delete(record.key); submitRecord(record); };
            });
        },
        onCancel() {
            record.cancelled = true;
            record.root.querySelectorAll('[role="status"]').forEach(n => {
                n.textContent = '🐱 分析已取消，点击继续'; n.style.cursor = 'pointer';
                n.onclick = () => { record.cancelled = false; scanCoordinator.jobs.delete(record.key); submitRecord(record); };
            });
        }
    });
}
function receive(win, raw, capturedChat, callId) {
    if (!capturedChat || !running || settings.feBridge === false || settings.pluginOn === false || getChatId() !== capturedChat) return;
    const text = extractNarrativeText(raw);
    if (!tokenizePlaceholders(text).length) return;
    if (getSTContext()?.chat?.some(message => !message.is_user && extractNarrativeText(message.mes) === text)) return;
    const signature = capturedChat + ':' + frameId(win) + ':' + callId + ':' + fingerprint(text);
    if (records.has(signature)) return;
    const mode = getActiveMode(), tokens = tokenizePlaceholders(text);
    const id = 'fe-' + globalThis.crypto.randomUUID().replace(/-/g, '');
    const key = getMsgKey(capturedChat, id, text, 0, mode);
    const record = { key, chatId: capturedChat, messageId: id, callId, mode, win, text, source: text, swipe: 0, results: new Map(), root: null,
        slots: tokens.map(token => ({ id: key + '#' + token.index })) };
    record.autoEligible = settings.autoGen === 1;
    records.set(signature, record);
    if (!newestRecord || callId > newestRecord.callId) newestRecord = record;
    if (records.size > 100) records.delete(records.keys().next().value);
    // Let the card's own Promise continuation commit its final response first.
    setTimeout(() => { if (running) submitRecord(record); }, 150);
}
function wrap(win, name) {
    const helper = win.TavernHelper, original = helper?.[name];
    if (typeof original !== 'function' || original.__sillab_fe) return;
    const wrapped = function (params, ...rest) {
        const capturedChat = getChatId();
        const isScene = sceneCall(params), callId = ++serial;
        let callParams = params;
        if (running && settings.pluginOn !== false && settings.feBridgeMode === 'director' && sceneCall(params)) {
            const instruction = getPrompt('main-llm-instruction.txt');
            if (instruction) callParams = { ...params, user_input: String(params?.user_input || '') + '\n' + instruction };
        }
        if (isScene) { latestCalls.set(win, callId); inflight.set(win, (inflight.get(win) || 0) + 1); }
        const finish = () => {
            if (isScene) { inflight.set(win, Math.max(0, (inflight.get(win) || 0) - 1)); holdUntil.set(win, Date.now() + 350); }
        };
        let result;
        try { result = original.call(this, callParams, ...rest); } catch (error) { finish(); throw error; }
        if (!isScene) return result;
        if (result?.then) return result.then(value => { finish(); receive(win, value, capturedChat, callId); return value; }, error => { finish(); throw error; });
        finish();
        // Async iterables and generators are not complete replies; leave them alone.
        if (!result?.[Symbol.asyncIterator] && !result?.next) receive(win, result, capturedChat, callId);
        return result;
    };
    wrapped.__sillab_fe = true;
    helper[name] = wrapped;
    hooks.push(() => { if (helper[name] === wrapped) helper[name] = original; });
}
export function installFrontendHook() {
    if (!running || settings.feBridge === false) return false;
    eachWindow(win => { wrap(win, 'generate'); wrap(win, 'generateRaw'); bindImageButtonsIn(win.document); });
    return true;
}
function sweep() {
    if (!running || settings.feBridge === false) return;
    if (chatId !== getChatId()) { records.clear(); newestRecord = undefined; chatId = getChatId(); }
    installFrontendHook();
    for (const record of records.values()) submitRecord(record);
}
export function initFrontendBridge() {
    if (running) return;
    running = true; chatId = getChatId();
    installFrontendHook();
    timer = setInterval(sweep, 1500);
    observer = new MutationObserver(() => { clearTimeout(initFrontendBridge._debounce); initFrontendBridge._debounce = setTimeout(sweep, 200); });
    const root = document.querySelector('#chat');
    if (root) observer.observe(root, { childList: true, subtree: true });
    document.addEventListener('load', sweep, true);
    window.SILLAB_FE = { probe: probeFrontendApp, install: installFrontendHook, status: getFeBridgeStatus,
        test: injectTestCard };
    slLog('前端桥：来源窗口绑定 / generate + generateRaw / 独立队列');
}
export function stopFrontendBridge() {
    running = false; clearInterval(timer); clearTimeout(initFrontendBridge._debounce); observer?.disconnect();
    document.removeEventListener('load', sweep, true); hooks.splice(0).forEach(undo => undo()); records.clear(); newestRecord = undefined;
}
export function getFeBridgeStatus() {
    return settings.feBridge === false ? '已关闭' : '前端桥 · 已挂钩 ' + hooks.length + ' 个入口 · 回复 ' + records.size + ' 组';
}
export function probeFrontendApp() {
    const report = { running, enabled: settings.feBridge !== false, hooks: hooks.length, records: records.size };
    slLog('前端桥探针: ' + JSON.stringify(report)); return report;
}
export function injectTestCard() {
    let doc;
    eachWindow(win => { if (win !== window) doc = win.document; });
    if (!doc?.body) return false;
    const root = doc.createElement('div'), key = 'fe_test_' + ++serial;
    root.innerHTML = buildImgCard('前端桥测试图', '测试图卡（未调用 API）', '', key);
    doc.body.appendChild(root); bindImageButtonsIn(doc); return true;
}
