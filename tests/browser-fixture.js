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
    const ctx = { chatId: 'fixture', chat: [], characterId: 0, characters: [{ avatar: 'fixture.png', data: { name: 'Fixture' } }],
        eventSource, eventTypes, getRequestHeaders: () => ({}), setExtensionPrompt() {} };
    initSettings(() => ctx, {});
    Object.assign(settings, getDefaults(), { cWf: '{}', auxUrl: 'https://fixture.invalid', auxModel: 'fixture', autoGen: 0 });
    const { loadPrompts, getPrompt } = await import('../prompts/loader.js');
    await loadPrompts(new URL('../prompts/', import.meta.url).href);
    const scanner = await import('../modules/scanner.js');
    const bridge = await import('../modules/frontend-bridge.js');
    const { setEnqueueGen, buildImgCard } = await import('../modules/render.js');
    const queue = await import('../modules/queue.js');
    setEnqueueGen(queue.enqueueGen); settings.autoGen = 1;
    let calls = 0, generations = 0, lastAnalysis, lastWorkflow;
    const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8l0AAAAASUVORK5CYII=';
    const mockFetch = async (url, options) => {
        if (String(url).endsWith('/generate')) {
            lastWorkflow = JSON.parse(JSON.parse(options.body).prompt).prompt;
            generations++; return new Response(JSON.stringify({ data: pixel, format: 'png' }));
        }
        // Use an existing local image for the displayed mock result; no file is uploaded.
        if (String(url).endsWith('/upload')) return new Response(JSON.stringify({ path: '/img/ai4.png' }));
        calls++;
        lastAnalysis = JSON.parse(options.body);
        const user = JSON.parse(options.body).messages.at(-1).content;
        const prompt = user.includes('H3-FIXTURE') ? 'A compact painted scene shows a sign reading "Fixture的茶铺". The woman supports a cup with her left palm while her right hand rests around the handle.'
            : user.includes('红衣') ? 'RED-FIXTURE-PROMPT' : user.includes('蓝衣') ? 'BLUE-FIXTURE-PROMPT' : 'OTHER-FIXTURE-PROMPT';
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content:
            '---PROFILE---\n{}\n---END---\n---IMAGES---\n' + prompt + '\n---END---' } }] }), { status: 200 });
    };
    window.fetch = mockFetch;
    const checks = [];
    const wait = async fn => { for (let i = 0; i < 150; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('fixture timeout'); };
    const source = '前[img:同一场景|要点:红衣]中[img:同一场景|要点:蓝衣]后';
    document.body.innerHTML = '<div id="chat"><div class="mes" mesid="0"><div class="mes_text"></div></div></div>';
    const root = document.querySelector('.mes_text'); root.textContent = source;
    scanner.startPolling();
    ctx.chat = [{ mes: source, is_user: false, swipe_id: 0 }];
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
        const paragraph = document.createElement('p');
        paragraph.textContent = source;
        root.replaceChildren(paragraph); scanner.scanAllMsgs();
        checks.push({ name: 'webview-message-redraw-restores-without-api', ok: calls === before && root.querySelectorAll('.sl_img_btn').length === 2 });
        const ids = Array.from(root.querySelectorAll('.sl_img_btn'), b => b.dataset.slid);
        const beforeGen = generations;
        const cardIds = surface => Array.from(surface.querySelectorAll('p [data-sl-slot] .sl_img_result'), image =>
            image.closest('.sl_img_block').querySelector('.sl_img_btn').dataset.slid).join(',');
        for (let pass = 0; pass < 3; pass++) {
            const streamed = document.createElement('div');
            streamed.className = 'TH-streaming';
            streamed.innerHTML = jQuery('<div>').append(jQuery(root.innerHTML).toArray()).html();
            root.classList.add('hidden!');
            root.after(streamed);
            await wait(() => cardIds(streamed) === ids.join(',') && !root.querySelector('.sl_img_block'));
            streamed.hidden = true;
            root.classList.remove('hidden!');
            await wait(() => cardIds(root) === ids.join(',') && !streamed.querySelector('.sl_img_block'));
            streamed.remove();
        }
        checks.push({ name: 'webview-tavernhelper-streaming-toggles-preserve-two-cached-cards', ok: calls === before && generations === beforeGen });

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
        const panel = await import('../modules/ui/panel.js'), tabs = await import('../modules/ui/tabs.js');
        panel.showPanel(); tabs.renderSettingsPage();
        jQuery('#sl_model_type').val('minimax_h3_image').trigger('change');
        checks.push({ name: 'webview-h3-model-selection-and-guidance-card', ok: settings.modelType === 'minimax_h3_image' &&
            !!document.querySelector('#sl_model_type option[value="minimax_h3_image"]') && document.querySelector('#sl_minimax_h3_card').style.display !== 'none' &&
            document.querySelector('#sl_krea2_style_card').style.display === 'none' });
        settings.autoGen = 1;
        settings.cWf = '{"native":{"inputs":{"text":"%prompt%"}},"canvas":{"inputs":{"width":1152,"height":1280}}}';
        const { upsertPerson, setEnglishAnchor } = await import('../modules/roster.js');
        const { upsertEntry } = await import('../modules/wardrobe.js');
        const fixtureAnchor = 'race:FixtureOrigin | age:forty-two | nose:FixtureNose';
        const fixtureOutfit = 'FixtureBlue cotton jacket, FixtureRound collar';
        upsertPerson('FixtureActor', '层次测试', '本轮档案原文', 'anchor');
        setEnglishAnchor('FixtureActor', '层次测试', fixtureAnchor);
        upsertEntry('服装', 'FixtureOutfit', fixtureOutfit, 'expanded');
        ctx.chat[0].mes = '[img:H3-FIXTURE|人物:FixtureActor（层次测试）|造型:服装=FixtureOutfit|要点:招牌文字Fixture的茶铺，手托杯子]'; root.textContent = ctx.chat[0].mes;
        await scanner.runAuxImageScan(jQuery(root));
        await wait(() => !!root.querySelector('.sl_img_block img') && !scanner.scanCoordinator.running);
        const h3System = lastAnalysis.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
        checks.push({ name: 'webview-h3-overlay-reaches-analysis-and-keeps-quoted-lettering', ok: h3System.includes('【模式：MiniMax-H3-Image') &&
            h3System.includes(getPrompt('pipeline/minimax-h3-image-overlay.txt').trim()) &&
            !h3System.includes('【模式：Krea 2') && root.querySelector('.sl_img_btn').dataset.prompt.includes('"Fixture的茶铺"') });
        checks.push({ name: 'webview-h3-plain-caption-to-comfy-with-unchanged-canvas', ok: lastWorkflow.native.inputs.text.includes('"Fixture的茶铺"') &&
            lastWorkflow.canvas.inputs.width === 1152 && lastWorkflow.canvas.inputs.height === 1280 && !lastWorkflow.native.inputs.text.includes('expanded_caption') });
        const h3Overlay = getPrompt('pipeline/minimax-h3-image-overlay.txt').trim();
        const wardrobeRules = getPrompt('wardrobe-expand.txt').trim();
        const h3User = lastAnalysis.messages.at(-1).content;
        checks.push({ name: 'webview-shared-rules-overlay-and-records-stay-in-their-layers', ok:
            lastAnalysis.messages.some(m => m.role === 'system' && m.content === h3Overlay) &&
            h3System.indexOf('## 造型库具象化') < h3System.indexOf(wardrobeRules) && h3System.indexOf(wardrobeRules) < h3System.indexOf(h3Overlay) &&
            !/【人物档案】|【造型库】|\b(?:anchor|aura|portrait)\b|---(?:PROFILE|WARDROBE)---/.test(h3Overlay) &&
            h3User.includes(fixtureAnchor) && h3User.includes(fixtureOutfit) && !h3System.includes(fixtureAnchor) && !h3System.includes(fixtureOutfit) });
        return { ok: checks.every(c => c.ok), checks, mockedAnalysisRequests: calls, mockedImageRequests: generations, externalRequests: 0 };
    } finally { scanner.stopPolling(); bridge.stopFrontendBridge(); }
}
