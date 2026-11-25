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
    const extensionSettings = {};
    initSettings(() => ctx, extensionSettings);
    Object.assign(settings, getDefaults(), { cWf: '{}', auxUrl: 'https://fixture.invalid', auxModel: 'fixture', autoGen: 0 });
    const { loadPrompts, getPrompt } = await import('../prompts/loader.js');
    await loadPrompts(new URL('../prompts/', import.meta.url).href);
    const scanner = await import('../modules/scanner.js');
    const bridge = await import('../modules/frontend-bridge.js');
    const compact = await import('../modules/ui/compact-bar.js');
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
        const prompt = user.includes('MOSS-FIXTURE') ? JSON.stringify({
            summary: { canvas: 'single', caption: 'A waist-up view with cool light across the face and warm light on the cup.' },
            items: [
                { label: 'text', caption: 'A shop sign on the left', text: 'Fixture的茶铺\n"欢迎"', bbox: [-290, -790, -155, -370] },
                { label: 'character', caption: 'The woman holds a cup in her left palm', tags: ['42 years old', 'blue cotton jacket'], bbox: [-410, -190, 432, 630] },
            ],
            bbox_coord_space: 'abs_centralized', bbox_format: 'yxyx',
        })
            : user.includes('红衣') ? 'RED-FIXTURE-PROMPT' : user.includes('蓝衣') ? 'BLUE-FIXTURE-PROMPT' : 'OTHER-FIXTURE-PROMPT';
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content:
            '---PROFILE---\n{}\n---END---\n---IMAGES---\n' + prompt + '\n---END---' } }] }), { status: 200 });
    };
    window.fetch = mockFetch;
    const checks = [];
    const wait = async (fn, attempts = 150) => { for (let i = 0; i < attempts; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('fixture timeout'); };
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
            const sourceHtml = root.innerHTML;
            root.after(streamed);
            await wait(() => cardIds(streamed) === ids.join(',') && getComputedStyle(root).display === 'none');
            if (root.innerHTML !== sourceHtml) throw new Error('The hidden source was rewritten');
            const editor = document.createElement('textarea');
            editor.id = 'curEditTextarea';
            root.append(editor);
            scanner.scanAllMsgs();
            if (!editor.getClientRects().length) throw new Error('The editor was hidden with the source');
            editor.remove();
            scanner.scanAllMsgs();
            if (getComputedStyle(root).display !== 'none') throw new Error('Two reply surfaces are visible after editing');
            const overlap = streamed.cloneNode(true);
            overlap.removeAttribute('data-sl-active-stream');
            streamed.after(overlap);
            scanner.scanAllMsgs();
            if (getComputedStyle(overlap).display !== 'none') throw new Error('Two streaming copies are visible');
            streamed.style.display = 'none';
            await wait(() => overlap.hasAttribute('data-sl-active-stream') && getComputedStyle(overlap).display !== 'none');
            overlap.remove();
            streamed.style.removeProperty('display');
            const streamedHtml = streamed.innerHTML;
            streamed.hidden = true;
            await wait(() => cardIds(root) === ids.join(',') && getComputedStyle(root).display !== 'none' &&
                !streamed.hasAttribute('data-sl-active-stream'));
            if (streamed.innerHTML !== streamedHtml) throw new Error('The inactive copy was rewritten');
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
        compact.createCompactBar();
        const cancelRect = document.querySelector('#sl_comp_cancel').getBoundingClientRect(), barRect = document.querySelector('#sl_compact').getBoundingClientRect();
        checks.push({ name: 'webview-expanded-cancel-button-visible-and-in-bounds', ok: cancelRect.width > 0 && cancelRect.height > 0 &&
            cancelRect.left >= barRect.left && cancelRect.right <= barRect.right && cancelRect.bottom <= barRect.bottom });
        let analysisSignal, imageSignal, activeImageId, nativeCancel;
        let cancelledAnalysisCalls = 0, cancelledImageCalls = 0;
        window.fetch = async (url, options) => {
            if (String(url).endsWith('/cancel')) {
                nativeCancel = { url, method: options.method, aborted: options.signal.aborted };
                return Response.json({ cancelled: true });
            }
            if (String(url).endsWith('/generate')) {
                cancelledImageCalls++;
                activeImageId = JSON.parse(JSON.parse(options.body).prompt).prompt_id;
                imageSignal = options.signal;
            } else { cancelledAnalysisCalls++; analysisSignal = options.signal; }
            return new Promise((_resolve, reject) => {
                options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled fixture', 'AbortError')), { once: true });
            });
        };
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
                cancelledAnalysisCalls === 1 && cancelledImageCalls === 1 && nativeCancel?.method === 'POST' && !nativeCancel.aborted &&
                nativeCancel.url === settings.cUrl + '/api/jobs/' + activeImageId + '/cancel' });
        scanner.checkLastMessage();
        for (const btn of cards.querySelectorAll('.sl_img_btn')) queue.enqueueGen(jQuery(btn), '取消测试', { automatic: true });
        await new Promise(r => setTimeout(r, 1700));
        checks.push({ name: 'webview-cancelled-tasks-stay-cancelled-under-polling',
            ok: cancelledAnalysisCalls === 1 && cancelledImageCalls === 1 && !queue.getQueueStatus().running && !!root.querySelector('.sl_scan_retry') });
        window.fetch = mockFetch;
        root.querySelector('.sl_scan_retry').click();
        await wait(() => !!root.querySelector('.sl_img_btn') && !scanner.scanCoordinator.running);
        checks.push({ name: 'webview-cancelled-analysis-explicit-resume', ok: calls === oldCalls + 3 });
        const panel = await import('../modules/ui/panel.js'), tabs = await import('../modules/ui/tabs.js');
        panel.buildUI();
        panel.showPanel();
        const manualForm = document.querySelector('#sl_panel #sl_manual_queue');
        const manualField = manualForm.querySelector('input');
        const manualRect = manualForm.getBoundingClientRect();
        const beforeManual = generations;
        manualField.value = '0';
        manualForm.querySelector('button').click();
        await wait(() => root.querySelector('.sl_img_result') && !queue.getQueueStatus().running);
        checks.push({ name: 'webview-manual-floor-control-queues-existing-prompt',
            ok: calls === oldCalls + 3 && generations === beforeManual + 1 &&
                manualRect.top >= document.querySelector('#sl_btn_gen_all').getBoundingClientRect().bottom &&
                !document.querySelector('#sl_compact form') });
        const switchStyle = input => {
            const track = input.nextElementSibling;
            return { color: getComputedStyle(track).backgroundColor, thumb: getComputedStyle(track, '::after').transform };
        };
        const toggleSwitch = async input => {
            const before = switchStyle(input);
            input.closest('label').click();
            await wait(() => {
                const style = switchStyle(input);
                return style.color !== before.color && style.thumb !== before.thumb;
            });
        };
        const power = () => document.querySelector('#sl_home_hero #sl_plugin_on');
        const originalPower = power();
        await toggleSwitch(originalPower);
        checks.push({ name: 'webview-home-power-switch-pauses-in-place',
            ok: power() === originalPower && !power().checked && scanner.getScannerStatus() === 'off' &&
                extensionSettings.cat_image.pluginOn === false &&
                document.querySelector('#sl_home_status').textContent === '猫尾收起' });
        panel.hidePanel();
        const bar = document.querySelector('#sl_compact');
        bar.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
        const shadow = () => getComputedStyle(bar).boxShadow;
        const dot = () => getComputedStyle(document.querySelector('#sl_comp_status_dot')).backgroundColor;
        const expandedShadow = shadow();
        checks.push({ name: 'webview-paused-compact-bar-stays-visible-with-orange-status',
            ok: bar.getClientRects().length > 0 && !bar.classList.contains('sl_compact_logo') &&
                document.querySelector('#sl_comp_status').textContent === '猫尾收起' && dot() === 'rgb(255, 159, 10)' });
        bar.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
        await wait(() => bar.classList.contains('sl_compact_logo'), 200);
        checks.push({ name: 'webview-no-exterior-shadow-on-floating-bar-or-logo', ok: expandedShadow === 'none' && shadow() === 'none' });
        bar.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }));
        document.querySelector('#sl_comp_panel_btn').click();
        const reopened = power();
        const stillOff = reopened && !reopened.checked && !bar.getClientRects().length && document.querySelector('#sl_head_status_txt').textContent === '猫尾收起';
        await toggleSwitch(reopened);
        checks.push({ name: 'webview-reopen-panel-and-enable-while-paused', ok: stillOff && reopened.checked &&
            extensionSettings.cat_image.pluginOn === true && scanner.getScannerStatus() !== 'off' && dot() !== 'rgb(255, 159, 10)' });
        const home = document.querySelector('#sl_panel_home'), panelBody = home.parentElement;
        home.scrollTop = home.scrollHeight;
        const homeScroll = home.scrollTop;
        tabs.renderSettingsPage();
        const preferences = panelBody.querySelector('.sl-page');
        preferences.scrollTop = preferences.scrollHeight;
        const preferencesScroll = preferences.scrollTop;
        panelBody.scrollTop = 10000;
        const frameRect = panelBody.getBoundingClientRect(), pageRect = preferences.getBoundingClientRect();
        const coversPanel = homeScroll > 0 && preferencesScroll > 0 && panelBody.scrollTop === 0 &&
            home.getClientRects().length === 0 && Math.abs(frameRect.top - pageRect.top) < 1 &&
            Math.abs(frameRect.bottom - pageRect.bottom) < 1 &&
            Math.abs(preferences.querySelector('.sl_page_back').parentElement.getBoundingClientRect().top - pageRect.top) < 1;
        panel.pushPage(body => body.text('短子页'), '测试子页');
        const nested = [...panelBody.querySelectorAll('.sl-page')].at(-1);
        const topOnly = preferences.getClientRects().length === 0 && home.getClientRects().length === 0 &&
            Math.abs(nested.getBoundingClientRect().bottom - frameRect.bottom) < 1;
        nested.querySelector('.sl_page_back').click();
        const preferencesRestored = preferences.scrollTop === preferencesScroll && preferences.getClientRects().length > 0;
        preferences.querySelector('.sl_page_back').click();
        checks.push({ name: 'webview-subpages-cover-drawer-and-scroll-independently',
            ok: coversPanel && topOnly && preferencesRestored && home.getClientRects().length > 0 && home.scrollTop === homeScroll });
        tabs.renderSettingsPage();
        const promptSwitch = document.querySelector('#sl_show_prompt');
        await toggleSwitch(promptSwitch);
        const promptOn = promptSwitch.checked && extensionSettings.cat_image.showGenPrompt === true;
        await toggleSwitch(promptSwitch);
        checks.push({ name: 'webview-settings-prompt-switch-updates-in-place',
            ok: !document.querySelector('.sl_page_body #sl_plugin_on') && promptOn && !promptSwitch.checked &&
                extensionSettings.cat_image.showGenPrompt === false && document.querySelector('#sl_show_prompt') === promptSwitch });
        const bridgeInput = () => document.getElementById('sl_fe_bridge');
        const bridgeInitial = bridgeInput().checked;
        bridgeInput().click();
        const bridgeToggled = bridgeInput().checked === !bridgeInitial && extensionSettings.cat_image.feBridge === !bridgeInitial;
        bridgeInput().click();
        checks.push({ name: 'webview-frontend-bridge-switch-keeps-working',
            ok: bridgeToggled && bridgeInput().checked === bridgeInitial && extensionSettings.cat_image.feBridge === bridgeInitial });
        jQuery('#sl_model_type').val('moss_image').trigger('change');
        const mossWidth = document.querySelector('#sl_moss_width');
        mossWidth.value = '1600';
        mossWidth.dispatchEvent(new Event('change', { bubbles: true }));
        mossWidth.value = '1601';
        mossWidth.dispatchEvent(new Event('change', { bubbles: true }));
        const cgSelected = settings.modelType === 'moss_image' && document.querySelector('#sl_moss_card').style.display !== 'none';
        jQuery('#sl_model_type').val('moss_image_free').trigger('change');
        checks.push({ name: 'webview-moss-model-selection-and-canvas-settings', ok: cgSelected && extensionSettings.cat_image.modelType === 'moss_image_free' &&
            document.querySelector('#sl_moss_card').style.display !== 'none' && document.querySelector('#sl_krea2_style_card').style.display === 'none' &&
            mossWidth.value === '1600' && extensionSettings.cat_image.mossWidth === 1600 && document.querySelector('#sl_moss_height').value === '864' });
        settings.autoGen = 1;
        settings.cWf = '{"native":{"inputs":{"text":"%prompt%"}},"canvas":{"inputs":{"width":1600,"height":864}}}';
        const { upsertPerson, setEnglishAnchor } = await import('../modules/roster.js');
        const { upsertEntry } = await import('../modules/wardrobe.js');
        const fixtureAnchor = 'race:FixtureOrigin | age:forty-two | nose:FixtureNose';
        const fixtureOutfit = 'FixtureBlue cotton jacket, FixtureRound collar';
        upsertPerson('FixtureActor', '层次测试', '本轮档案原文', 'anchor');
        setEnglishAnchor('FixtureActor', '层次测试', fixtureAnchor);
        upsertEntry('服装', 'FixtureOutfit', fixtureOutfit, 'expanded');
        ctx.chat[0].mes = '[img:MOSS-FIXTURE|人物:FixtureActor（层次测试）|造型:服装=FixtureOutfit|要点:招牌文字Fixture的茶铺，手托杯子]'; root.textContent = ctx.chat[0].mes;
        await scanner.runAuxImageScan(jQuery(root));
        await wait(() => !!root.querySelector('.sl_img_block img') && !scanner.scanCoordinator.running);
        const mossSystem = lastAnalysis.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
        const mossOverlay = getPrompt('pipeline/moss-image-free-overlay.txt').trim();
        const mossPrompt = root.querySelector('.sl_img_btn').dataset.prompt;
        checks.push({ name: 'webview-moss-overlay-reaches-analysis-and-keeps-quoted-lettering', ok: mossSystem.includes(mossOverlay) &&
            !mossSystem.includes(getPrompt('pipeline/moss-image-overlay.txt').trim()) &&
            !mossSystem.includes('【模式：Krea 2') && JSON.parse(mossPrompt).items[0].text === 'Fixture的茶铺\n"欢迎"' &&
            !Object.hasOwn(JSON.parse(mossPrompt).summary, 'meta') });
        checks.push({ name: 'webview-moss-layout-reaches-comfy-with-unchanged-canvas', ok: lastWorkflow.native.inputs.text === mossPrompt &&
            lastWorkflow.canvas.inputs.width === 1600 && lastWorkflow.canvas.inputs.height === 864 });
        const wardrobeRules = getPrompt('wardrobe-expand.txt').trim();
        const mossUser = lastAnalysis.messages.at(-1).content;
        checks.push({ name: 'webview-shared-rules-overlay-and-records-stay-in-their-layers', ok:
            lastAnalysis.messages.some(m => m.role === 'system' && m.content === mossOverlay) &&
            mossSystem.indexOf('## 造型库具象化') < mossSystem.indexOf(wardrobeRules) && mossSystem.indexOf(wardrobeRules) < mossSystem.indexOf(mossOverlay) &&
            mossOverlay.includes('## 档案锚点 → character.tags') && mossOverlay.includes('## 造型库 detail →') &&
            !/---(?:PROFILE|WARDROBE)---/.test(mossOverlay) &&
            mossUser.includes('实际宽 1600 px，高 864 px') &&
            mossUser.includes(fixtureAnchor) && mossUser.includes(fixtureOutfit) && !mossSystem.includes(fixtureAnchor) && !mossSystem.includes(fixtureOutfit) });

        const { sessionData, sessionKey } = await import('../modules/archive.js');
        const historyTitle = 'Fixture - older chat';
        const historical = sessionData(sessionKey('fixture.png', historyTitle), true);
        historical.roster.Alex = { key: 'Alex', name: 'Alex' };
        historical.gallery['/img/ai4.png'] = { url: '/img/ai4.png', ts: Date.now() };
        window.fetch = (url, options) => url === '/api/characters/chats'
            ? Promise.resolve(Response.json([{ file_name: historyTitle + '.jsonl' }])) : mockFetch(url, options);
        panel.popPage();
        tabs.renderArchivePage();
        const historyRow = () => document.querySelector('[data-roster-context] .sl_other_chats details[data-chat]');
        await wait(() => !!historyRow()?.querySelector('.sl_chat_switch'));
        historyRow().parentElement.open = true;
        historyRow().open = true;
        const density = group => {
            const row = getComputedStyle(group), title = getComputedStyle(group.querySelector('summary'));
            return [row.marginTop, row.paddingTop, title.paddingTop, title.marginBottom, title.fontSize].join(' ');
        };
        const rosterDensity = density(historyRow());
        const actions = [...historyRow().querySelector('.sl_roster_delete').parentElement.children];
        const redDelete = actions.map(button => button.textContent).join('|') === '切换聊天|复制档案到当前聊天|删除本档案' &&
            getComputedStyle(actions.at(-1)).backgroundColor === 'rgb(255, 59, 48)';
        panel.popPage();
        tabs.renderGalleryPage();
        const galleryGroup = document.querySelector('.sl-page .sl_other_chats');
        galleryGroup.open = true;
        checks.push({ name: 'webview-archive-chat-spacing-matches-gallery', ok: redDelete && rosterDensity === density(galleryGroup.querySelector('details')) });

        const { applyTheme } = await import('../modules/ui/theme.js');
        const { openSubPanel } = await import('../modules/ui/sub-panels.js');
        for (const theme of ['云朵棉花猫', '星空夜猫']) {
            settings.uiTheme = theme;
            applyTheme(theme);
            compact.rebuildCompactBar();
            panel.showPanel();
            const homeAction = document.querySelector('#sl_btn_gen_all');
            const background = getComputedStyle(homeAction).backgroundColor;
            const compactAction = document.querySelector('#sl_comp_gen');
            openSubPanel('aux');
            const testAction = document.querySelector('#sl_test_aux');
            const panelButtonsFlat = [homeAction, testAction, compactAction]
                .every(button => getComputedStyle(button).boxShadow === 'none');
            panel.popPage();
            tabs.renderArchivePage();
            document.querySelector('[data-roster-context] > details .sl_pcard').click();
            const remove = document.querySelector('.sl_person_delete');
            const prompt = document.querySelector('.sl_prompt_btn');
            const removalRect = remove.getBoundingClientRect(), promptRect = prompt.getBoundingClientRect();
            prompt.click();
            const promptBox = document.querySelector('.sl_prompt_box');
            const buttons = [...promptBox.querySelectorAll('button')].filter(button => button.getClientRects().length);
            const promptActionsFlat = [prompt, ...buttons].every(button => getComputedStyle(button).boxShadow === 'none');
            checks.push({ name: 'webview-flat-blue-buttons-and-aligned-portrait-actions-' + theme,
                ok: panelButtonsFlat && promptActionsFlat && getComputedStyle(prompt).backgroundColor === background &&
                    remove.nextElementSibling === prompt && promptRect.left > removalRect.right && removalRect.width > 0 &&
                    Math.abs(removalRect.width - promptRect.width) < 1 && Math.abs(removalRect.height - promptRect.height) < 1 &&
                    Math.abs(removalRect.top - promptRect.top) < 1 && prompt.getAttribute('aria-expanded') === 'true' &&
                    buttons.map(button => button.textContent).join('|') === '修改提示词|重新生成' });
        }
        return { ok: checks.every(c => c.ok), checks, mockedAnalysisRequests: calls, mockedImageRequests: generations, externalRequests: 0 };
    } finally { compact.removeCompactBar(); scanner.stopPolling(); bridge.stopFrontendBridge(); }
}
