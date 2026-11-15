// Frontend replies use the same scheduler and DOM slots as normal chat messages.
// No property traps, global first-iframe target, pending-turn overwrite or tail append.
import { settings, getSTContext } from './settings.js';
import { slLog, slErr } from './log.js';
import { getChatId } from './pipeline/profile.js';
import { runRosterPipeline } from './pipeline/roster-pipeline.js';
import { scanCoordinator, generationBusy } from './scanner.js';
import { renderEnhancedLite, extractImgBlocksFromEnhanced, buildImgCard, bindImageButtonsIn } from './render.js';
import { fingerprint, tokenizePlaceholders } from './placeholders.js';
import { locateMarkers } from './dom-placeholders.js';
import { getPrompt } from '../prompts/loader.js';

let running = false, timer, serial = 0, chatId = '', observer;
const hooks = [], records = new Map(), frameIds = new WeakMap();
let frameSerial = 0;

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
            if (markers.every((m, i) => norm(m.content) === norm(tokens[i].content))) return root;
        }
        return null;
    };
    try {
        const own = find(win);
        if (own && win !== window) return own;
        // Top-level helper calls can originate in an iframe: match exact content.
        let found = null;
        eachWindow(w => { if (w !== window) { const root = find(w); if (root) found = root; } });
        return found || own;
    } catch { return null; }
}
function visibleRecord(record) {
    try {
        return record.root?.isConnected && record.root.ownerDocument.defaultView?.frameElement?.isConnected !== false &&
            (Array.from(record.root.querySelectorAll('[data-sl-slot]')).some(n => n.dataset.slSlot.startsWith(record.key + '#')) ||
                !!findTarget(record.win, record.text));
    } catch { return false; }
}
function submitRecord(record) {
    if (generationBusy() || settings.pluginOn === false) return;
    if (!record.root?.isConnected) record.root = findTarget(record.win, record.text);
    if (!record.root) return;
    renderEnhancedLite(jQuery(record.root), record.enhanced || record.blocks || null, record.key, record.text);
    if (record.enhanced) return;
    scanCoordinator.submit({ owner: record.key, key: record.key, source: record.text,
        isCurrent: () => running && settings.feBridge !== false && settings.pluginOn !== false &&
            getChatId() === record.chatId && !generationBusy() && visibleRecord(record),
        run: (isCurrent, signal) => runRosterPipeline(record.text, record.key, { isCurrent, signal, results: record.results,
            onSlot(index, enhanced) {
                if (!isCurrent()) return;
                record.blocks ||= [];
                record.blocks[index] = extractImgBlocksFromEnhanced(enhanced, record.key, index)[0];
                renderEnhancedLite(jQuery(record.root), record.blocks, record.key, record.text);
            } }),
        commit(result) {
            record.enhanced = result.enhanced;
            renderEnhancedLite(jQuery(record.root), result.enhanced, record.key, record.text);
        },
        onError() {
            record.root.querySelectorAll('[role="status"]').forEach(n => { n.textContent = '🐱 分析失败，稍后重试'; });
        }
    });
}
function receive(win, raw, capturedChat) {
    if (!running || settings.feBridge === false || settings.pluginOn === false || getChatId() !== capturedChat) return;
    const text = extractNarrativeText(raw);
    if (!tokenizePlaceholders(text).length) return;
    if (getSTContext()?.chat?.some(message => !message.is_user && extractNarrativeText(message.mes) === text)) return;
    const signature = capturedChat + ':' + frameId(win) + ':' + fingerprint(text);
    if (records.has(signature)) return;
    const record = { key: 'fe_v2_' + signature, chatId: capturedChat, win, text, results: new Map(), root: null };
    records.set(signature, record);
    if (records.size > 100) records.delete(records.keys().next().value);
    // Let the card's own Promise continuation commit its final response first.
    setTimeout(() => { if (running) submitRecord(record); }, 150);
}
function wrap(win, name) {
    const helper = win.TavernHelper, original = helper?.[name];
    if (typeof original !== 'function' || original.__sillab_fe) return;
    const wrapped = function (params, ...rest) {
        const capturedChat = getChatId();
        let callParams = params;
        if (running && settings.pluginOn !== false && settings.feBridgeMode === 'director' && sceneCall(params)) {
            const instruction = getPrompt('main-llm-instruction.txt');
            if (instruction) callParams = { ...params, user_input: String(params?.user_input || '') + '\n' + instruction };
        }
        const result = original.call(this, callParams, ...rest);
        if (!sceneCall(params)) return result;
        if (result?.then) return result.then(value => { receive(win, value, capturedChat); return value; });
        // Async iterables and generators are not complete replies; leave them alone.
        if (!result?.[Symbol.asyncIterator] && !result?.next) receive(win, result, capturedChat);
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
    if (chatId !== getChatId()) { records.clear(); chatId = getChatId(); }
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
        test: injectTestCard, testDirector: injectTestDirector };
    slLog('前端桥 v2：来源窗口绑定 / generate + generateRaw / 独立队列');
}
export function stopFrontendBridge() {
    running = false; clearInterval(timer); clearTimeout(initFrontendBridge._debounce); observer?.disconnect();
    document.removeEventListener('load', sweep, true); hooks.splice(0).forEach(undo => undo()); records.clear();
}
export function getFeBridgeStatus() {
    return settings.feBridge === false ? '已关闭' : '前端桥 v2 · 已挂钩 ' + hooks.length + ' 个入口 · 回复 ' + records.size + ' 组';
}
export function probeFrontendApp() {
    const report = { running, enabled: settings.feBridge !== false, hooks: hooks.length, records: records.size };
    slLog('前端桥探针: ' + JSON.stringify(report)); return report;
}
export function injectTestDirector() { return injectTestCard(); }
export function injectTestCard() {
    let doc;
    eachWindow(win => { if (win !== window) doc = win.document; });
    if (!doc?.body) return false;
    const root = doc.createElement('div'), key = 'fe_test_' + ++serial;
    root.innerHTML = buildImgCard('前端桥测试图', '测试图卡（未调用 API）', '', key);
    doc.body.appendChild(root); bindImageButtonsIn(doc); return true;
}
