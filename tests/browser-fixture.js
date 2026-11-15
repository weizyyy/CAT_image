// Runs in a disposable same-origin iframe inside the real Tauritavern WebView.
// Storage, context and HTTP are isolated from the user's chat and credentials.
export async function runBrowserFixture() {
    const memory = new Map();
    Object.defineProperty(window, 'localStorage', { value: { getItem: k => memory.get(k) ?? null,
        setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k) }, configurable: true });
    Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true });
    window.toastr = { info() {}, error() {}, warning() {}, success() {} };
    const { settings, getDefaults, initSettings } = await import('../modules/settings.js');
    const handlers = new Map();
    const eventSource = { on(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
        off(name, fn) { handlers.get(name)?.delete(fn); }, emit(name, ...args) { for (const fn of handlers.get(name) || []) fn(...args); } };
    const eventTypes = Object.fromEntries(['GENERATION_STARTED','GENERATION_ENDED','MESSAGE_UPDATED','MESSAGE_RECEIVED','MESSAGE_EDITED','MESSAGE_SWIPED','CHAT_CHANGED'].map(x => [x, x]));
    const ctx = { chatId: 'fixture', chat: [], characterId: 0, characters: [{ data: { name: 'Fixture' } }],
        eventSource, eventTypes, getRequestHeaders: () => ({}), setExtensionPrompt() {} };
    initSettings(() => ctx, {});
    Object.assign(settings, getDefaults(), { cWf: '{}', auxUrl: 'https://fixture.invalid', auxModel: 'fixture', autoGen: 0, storyLib: false });
    const { loadPrompts } = await import('../prompts/loader.js');
    await loadPrompts(new URL('../prompts/', import.meta.url).href);
    const scanner = await import('../modules/scanner.js');
    const bridge = await import('../modules/frontend-bridge.js');
    const { setEnqueueGen, buildImgCard } = await import('../modules/render.js');
    const queue = await import('../modules/queue.js');
    setEnqueueGen(queue.enqueueGen); settings.autoGen = 1;
    let calls = 0, generations = 0;
    const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8l0AAAAASUVORK5CYII=';
    const mockFetch = async (url, options) => {
        if (String(url).endsWith('/generate')) {
            generations++; return new Response(JSON.stringify({ data: pixel, format: 'png' }));
        }
        // Use an existing local image for the displayed mock result; no file is uploaded.
        if (String(url).endsWith('/upload')) return new Response(JSON.stringify({ path: '/img/ai4.png' }));
        calls++;
        const user = JSON.parse(options.body).messages.at(-1).content;
        const prompt = user.includes('红衣') ? 'RED-FIXTURE-PROMPT' : user.includes('蓝衣') ? 'BLUE-FIXTURE-PROMPT' : 'OTHER-FIXTURE-PROMPT';
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content:
            '---PROFILE---\n{}\n---END---\n---IMAGES---\n' + prompt + '\n---END---' } }] }), { status: 200 });
    };
    window.fetch = mockFetch;
    const checks = [];
    const wait = async fn => { for (let i = 0; i < 150; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('fixture timeout'); };
    const source = '前[img:同一场景|要点:红衣]中[img:同一场景|要点:蓝衣]后';
    document.body.innerHTML = '<div id="chat"><div class="mes" mesid="0"><div class="mes_text"></div></div></div>';
    const root = document.querySelector('.mes_text'); root.textContent = source;
    ctx.chat = [{ mes: source, is_user: false, swipe_id: 0 }];
    scanner.startPolling();
    try {
        eventSource.emit('GENERATION_STARTED', 'normal', {}, false);
        await scanner.runAuxImageScan(jQuery(root));
        checks.push({ name: 'webview-no-processing-during-generation', ok: calls === 0 && !root.querySelector('[data-sl-slot]') });
        eventSource.emit('GENERATION_ENDED');
        await scanner.runAuxImageScan(jQuery(root));
        await wait(() => root.querySelectorAll('.sl_img_block img').length === 2 && !scanner.scanCoordinator.running);
        const prompts = Array.from(root.querySelectorAll('.sl_img_btn'), b => b.dataset.prompt);
        checks.push({ name: 'webview-real-pipeline-distinct-slots', ok: calls === 2 && prompts[0] === 'RED-FIXTURE-PROMPT' && prompts[1] === 'BLUE-FIXTURE-PROMPT' });
        const before = calls;
        root.textContent = source; scanner.scanAllMsgs();
        checks.push({ name: 'webview-message-redraw-restores-without-api', ok: calls === before && root.querySelectorAll('.sl_img_btn').length === 2 });
        const ids = Array.from(root.querySelectorAll('.sl_img_btn'), b => b.dataset.slid);
        const beforeGen = generations;
        ctx.chat[0].mes = source.replace('蓝衣', '绿衣'); root.textContent = ctx.chat[0].mes;
        await scanner.runAuxImageScan(jQuery(root));
        await wait(() => root.querySelectorAll('.sl_img_block img').length === 2 && !scanner.scanCoordinator.running);
        const editedIds = Array.from(root.querySelectorAll('.sl_img_btn'), b => b.dataset.slid);
        checks.push({ name: 'webview-single-marker-edit-only-one-analysis-and-generation',
            ok: calls === before + 1 && generations === beforeGen + 1 && ids[0] === editedIds[0] && ids[1] !== editedIds[1] });
        const editedSource = ctx.chat[0].mes, beforeAppend = calls;
        ctx.chat[0].mes = editedSource + '[img:新增尾部图]'; root.textContent = ctx.chat[0].mes;
        await scanner.runAuxImageScan(jQuery(root)); await wait(() => root.querySelectorAll('.sl_img_block img').length === 3 && !scanner.scanCoordinator.running);
        checks.push({ name: 'webview-appended-marker-only-new-slot-processed', ok: calls === beforeAppend + 1 });
        const frame = document.createElement('iframe');
        frame.srcdoc = '<div id="narrativeArea"><div class="msg-narrator"></div></div>';
        document.body.appendChild(frame); await new Promise(r => frame.addEventListener('load', r, { once: true }));
        const frontText = '[img:前端场景|要点:蓝衣][img:前端场景|要点:红衣]';
        frame.contentWindow.TavernHelper = { generate: async () => {
            frame.contentDocument.querySelector('.msg-narrator').textContent = frontText;
            return { narrative: frontText };
        } };
        bridge.initFrontendBridge();
        await frame.contentWindow.TavernHelper.generate({});
        await wait(() => frame.contentDocument.querySelectorAll('.sl_img_btn').length === 2);
        const framePrompts = Array.from(frame.contentDocument.querySelectorAll('.sl_img_btn'), b => b.dataset.prompt);
        checks.push({ name: 'webview-frontend-helper-owning-iframe', ok: framePrompts[0] === 'BLUE-FIXTURE-PROMPT' && framePrompts[1] === 'RED-FIXTURE-PROMPT' });
        const oldId = frame.contentDocument.querySelector('.sl_img_btn').dataset.slid;
        const oldCalls = calls;
        await frame.contentWindow.TavernHelper.generate({});
        await wait(() => frame.contentDocument.querySelectorAll('.sl_img_btn').length === 2 && frame.contentDocument.querySelector('.sl_img_btn').dataset.slid !== oldId);
        checks.push({ name: 'webview-frontend-identical-new-turn-rechecks', ok: calls === oldCalls + 2 });
        bridge.stopFrontendBridge(); settings.autoGen = 0;
        await wait(() => !queue.getQueueStatus().running);
        const compact = await import('../modules/ui/compact-bar.js'); compact.createCompactBar();
        const cancelRect = document.querySelector('#sl_comp_cancel').getBoundingClientRect(), barRect = document.querySelector('#sl_compact').getBoundingClientRect();
        checks.push({ name: 'webview-expanded-cancel-button-visible-and-in-bounds', ok: cancelRect.width > 0 && cancelRect.height > 0 &&
            cancelRect.left >= barRect.left && cancelRect.right <= barRect.right && cancelRect.bottom <= barRect.bottom });
        let analysisSignal, imageSignal, cancelledAnalysisCalls = 0, cancelledImageCalls = 0;
        window.fetch = (url, options) => new Promise((_resolve, reject) => {
            if (String(url).endsWith('/generate')) { cancelledImageCalls++; imageSignal = options.signal; }
            else { cancelledAnalysisCalls++; analysisSignal = options.signal; }
            options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled fixture', 'AbortError')), { once: true });
        });
        ctx.chat[0].mes = '[img:取消分析]'; root.textContent = ctx.chat[0].mes;
        await scanner.runAuxImageScan(jQuery(root)); await wait(() => analysisSignal);
        const cards = document.createElement('div');
        cards.innerHTML = [0, 1, 2].map(i => buildImgCard('取消' + i, '取消测试', '', 'cancel-fixture#' + i)).join('');
        document.body.appendChild(cards);
        for (const btn of cards.querySelectorAll('.sl_img_btn')) queue.enqueueGen(jQuery(btn), '取消测试');
        const queued = queue.getQueueStatus().queued;
        document.querySelector('#sl_comp_cancel').click();
        await wait(() => !scanner.scanCoordinator.running && !queue.getQueueStatus().running);
        checks.push({ name: 'webview-cancel-button-aborts-analysis-and-image-and-clears-two-waiting',
            ok: queued === 2 && analysisSignal.aborted && imageSignal.aborted && queue.getQueueStatus().queued === 0 &&
                cancelledAnalysisCalls === 1 && cancelledImageCalls === 1 });
        scanner.checkLastMessage();
        for (const btn of cards.querySelectorAll('.sl_img_btn')) queue.enqueueGen(jQuery(btn), '取消测试', { automatic: true });
        await new Promise(r => setTimeout(r, 1700));
        checks.push({ name: 'webview-cancelled-tasks-stay-cancelled-under-polling',
            ok: cancelledAnalysisCalls === 1 && cancelledImageCalls === 1 && !queue.getQueueStatus().running && !!root.querySelector('.sl_scan_retry') });
        window.fetch = mockFetch;
        root.querySelector('.sl_scan_retry').click();
        await wait(() => !!root.querySelector('.sl_img_btn') && !scanner.scanCoordinator.running);
        checks.push({ name: 'webview-cancelled-analysis-explicit-resume', ok: calls === oldCalls + 3 });
        compact.setPluginEnabled(false);
        return { ok: checks.every(c => c.ok), checks, mockedAnalysisRequests: calls, mockedImageRequests: generations, externalRequests: 0 };
    } finally { scanner.stopPolling(); bridge.stopFrontendBridge(); }
}
