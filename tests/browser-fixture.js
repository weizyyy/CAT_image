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
    let calls = 0;
    window.fetch = async (_url, options) => {
        calls++;
        const user = JSON.parse(options.body).messages.at(-1).content;
        const prompt = user.includes('红衣') ? 'RED-FIXTURE-PROMPT' : user.includes('蓝衣') ? 'BLUE-FIXTURE-PROMPT' : 'OTHER-FIXTURE-PROMPT';
        return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content:
            '---PROFILE---\n{}\n---END---\n---IMAGES---\n' + prompt + '\n---END---' } }] }), { status: 200 });
    };
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
        await wait(() => root.querySelectorAll('.sl_img_btn').length === 2);
        const prompts = Array.from(root.querySelectorAll('.sl_img_btn'), b => b.dataset.prompt);
        checks.push({ name: 'webview-real-pipeline-distinct-slots', ok: calls === 2 && prompts[0] === 'RED-FIXTURE-PROMPT' && prompts[1] === 'BLUE-FIXTURE-PROMPT' });
        const before = calls;
        root.textContent = source; scanner.scanAllMsgs();
        checks.push({ name: 'webview-message-redraw-restores-without-api', ok: calls === before && root.querySelectorAll('.sl_img_btn').length === 2 });
        ctx.chat[0].mes = source + '[img:新增尾部图]'; root.textContent = ctx.chat[0].mes;
        await scanner.runAuxImageScan(jQuery(root)); await wait(() => root.querySelectorAll('.sl_img_btn').length === 3);
        checks.push({ name: 'webview-late-edit-full-response-rescan', ok: calls === before + 3 });
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
        return { ok: checks.every(c => c.ok), checks, mockedAnalysisRequests: calls, externalRequests: 0 };
    } finally { scanner.stopPolling(); bridge.stopFrontendBridge(); }
}
