import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import jquery from 'jquery';
import { settings, getDefaults, initSettings } from '../modules/settings.js';

const dom = new JSDOM('<div id="chat"></div>', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
    MutationObserver: dom.window.MutationObserver, NodeFilter: dom.window.NodeFilter, getComputedStyle: dom.window.getComputedStyle,
    jQuery: jquery(dom.window), toastr: { info() {}, error() {}, success() {}, warning() {} } });
globalThis.$ = jQuery;
const eventSource = new EventEmitter();
const types = Object.fromEntries(['GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED','MESSAGE_UPDATED','MESSAGE_RECEIVED',
    'MESSAGE_SWIPED','MESSAGE_EDITED','MESSAGE_DELETED','CHARACTER_MESSAGE_RENDERED','CHAT_CHANGED'].map(x => [x, x]));
const ctx = { chat: [], chatId: 'test', characters: [{ avatar: 'tester.png', data: { name: 'Tester' }, chat: 'test' }], characterId: 0,
    eventSource, eventTypes: types, getRequestHeaders: () => ({}), setExtensionPrompt() {} };
initSettings(() => ctx, {});
Object.assign(settings, getDefaults(), { cWf: '{}', auxUrl: 'http://analysis.local', auxModel: 'test', autoGen: 0 });
const { loadPrompts } = await import('../prompts/loader.js');
globalThis.fetch = async url => ({ ok: true, text: () => readFile(new URL('../prompts/' + String(url).split('?')[0], import.meta.url), 'utf8') });
await loadPrompts('');
const { archive, sessionData, currentSession, sessionKey } = await import('../modules/archive.js');
const { galleryAdd } = await import('../modules/gallery.js');
const keyFor = file => sessionKey('tester.png', file);
const liveSession = () => sessionData(currentSession().key);
test.beforeEach(() => { archive.sessions = {}; });
const scanner = await import('../modules/scanner.js');
const { runRosterPipeline, parseRosterImages } = await import('../modules/pipeline/roster-pipeline.js');
const { extractNarrativeText, initFrontendBridge, stopFrontendBridge } = await import('../modules/frontend-bridge.js');
const waitUntil = async fn => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } assert.fail('timed out'); };
const response = prompt => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content:
    '---PROFILE---\n{}\n---END---\n---IMAGES---\n' + prompt + '\n---END---' } }] }) });
function show(source) {
    ctx.chat = [{ mes: source, is_user: false, swipe_id: 0 }];
    document.querySelector('#chat').innerHTML = '<div class="mes" mesid="0"><div class="mes_text"></div></div>';
    document.querySelector('.mes_text').textContent = source;
}

test('real pipeline isolates identical scenes and preserves multiline prompt paragraphs', async () => {
    let calls = 0; const inputs = [];
    fetch = async (_url, options) => { inputs.push(JSON.parse(options.body).messages.at(-1).content); return response('独立提示词' + ++calls + '\n细节段落，不应被拆成另一幅图。'); };
    const source = '短[img:同一场景|要点:红衣]中[img:同一场景|要点:蓝衣]后';
    const result = await runRosterPipeline(source, '0');
    assert.equal(result.ok, true); assert.equal(calls, 2);
    assert.equal(inputs[0].includes('蓝衣'), false); assert.equal(inputs[1].includes('红衣'), false);
    assert.ok(result.enhanced.includes('独立提示词1')); assert.ok(result.enhanced.includes('独立提示词2'));
    assert.equal(parseRosterImages('---IMAGES---\na long first line\na long second line\n---END---', 1).length, 1);
});

test('switching to automatic queues only the new last assistant floor', async () => {
    const { setEnqueueGen } = await import('../modules/render.js');
    const { enqueueGen } = await import('../modules/queue.js');
    const queued = [];
    const saved = settings.autoGen;
    try {
        settings.autoGen = 0;
        setEnqueueGen(btn => { queued.push(btn.closest('.mes').attr('mesid')); btn.text('排队中…'); });
        show('[img:积压图]'); scanner.startPolling();
        fetch = async () => response('A scene.');
        await scanner.runAuxImageScan(jQuery('.mes_text'));
        await waitUntil(() => !!document.querySelector('.sl_img_btn'));
        settings.autoGen = 1; scanner.resetAutomaticBacklog(); scanner.scanAllMsgs();
        assert.deepEqual(queued, []);
        ctx.chat.push({ mes: '[img:新楼层]', is_user: false });
        document.querySelector('#chat').insertAdjacentHTML('beforeend', '<div class="mes" mesid="1"><div class="mes_text">[img:新楼层]</div></div>');
        await scanner.runAuxImageScan(jQuery('.mes[mesid="1"] .mes_text'));
        await waitUntil(() => queued.length > 0);
        assert.deepEqual(queued, ['1']);
    } finally {
        scanner.stopPolling(); setEnqueueGen(enqueueGen);
        settings.autoGen = saved;
    }
});

test('TavernHelper visible streaming sibling restores finished slots and reanalyzes only the clicked marker', async () => {

    const source = '开头[img:第一处]中间[img:第二处]结尾';
    show(source); scanner.startPolling();
    const parent = document.querySelector('.mes');
    const original = parent.querySelector('.mes_text');
    original.classList.add('hidden!');
    const streamed = document.createElement('div');
    streamed.className = 'TH-streaming';
    streamed.innerHTML = '开头[img:<em>第一处</em>]中间[img:第二处]结尾';
    parent.append(streamed);
    let requests = 0;
    fetch = async () => response('Scene number ' + ++requests + '.');
    try {
        eventSource.emit(types.GENERATION_STARTED, 'normal', {}, false);
        await scanner.runAuxImageScan(jQuery(streamed));
        assert.equal(requests, 0);
        assert.equal(streamed.querySelectorAll('.sl_img_block').length, 0);
        eventSource.emit(types.GENERATION_ENDED);
        await scanner.runAuxImageScan(jQuery(streamed));
        await waitUntil(() => streamed.querySelectorAll('.sl_img_block').length === 2 && !scanner.scanCoordinator.running);
        assert.equal(original.textContent, source);
        streamed.textContent = source;
        scanner.scanAllMsgs();
        const ids = [...streamed.querySelectorAll('.sl_img_btn')].map(btn => btn.dataset.slid);
        const gen = getComputedStyle(streamed.querySelector('.sl_img_btn'));
        const retry = getComputedStyle(streamed.querySelector('.sl_img_reanalyze'));
        assert.equal(gen.padding, '5px 14px');
        for (const property of ['padding', 'borderRadius', 'fontSize', 'fontWeight', 'verticalAlign'])
            assert.equal(retry[property], gen[property]);
        assert.equal(retry.backgroundColor, 'rgb(201, 241, 213)');
        streamed.querySelectorAll('.sl_img_reanalyze')[1].click();
        await waitUntil(() => streamed.querySelectorAll('.sl_img_btn')[1].dataset.prompt === 'Scene number 3.');
        assert.equal(requests, 3);
        assert.equal(streamed.querySelectorAll('.sl_img_btn')[0].dataset.slid, ids[0]);
        assert.notEqual(streamed.querySelectorAll('.sl_img_btn')[1].dataset.slid, ids[1]);
    } finally { scanner.stopPolling(); }
});

test('a branch uses only its selected gallery for exact marker matches', async () => {
    const { setGalleryCacheSource, galleryCacheSource } = await import('../modules/gallery.js');
    const original = ctx.chatId;

    const marker = '[img:会话复用测试]';
    const source = marker + ' 中间 ' + marker;
    let calls = 0;
    fetch = async () => response('Prompt ' + ++calls + '.');
    try {
        show(source); scanner.startPolling();
        await scanner.runAuxImageScan(jQuery('.mes_text'));
        await waitUntil(() => document.querySelectorAll('.sl_img_btn').length === 2);
        const ids = [...document.querySelectorAll('.sl_img_btn')].map(btn => btn.dataset.slid);
        galleryAdd('/branch-a.png', { blockId: ids[0] }); galleryAdd('/branch-b.png', { blockId: ids[1] });
        ctx.chatId = 'another'; show(source);
        eventSource.emit(types.CHAT_CHANGED);
        await scanner.runAuxImageScan(jQuery('.mes_text'));
        await waitUntil(() => document.querySelectorAll('.sl_img_btn').length === 2 && !scanner.scanCoordinator.running);
        galleryAdd('/unselected.png', { blockId: document.querySelector('.sl_img_btn').dataset.slid });
        ctx.chatId = 'branch'; show('分支正文 ' + source);
        eventSource.emit(types.CHAT_CHANGED);
        scanner.scanAllMsgs();
        assert.equal(galleryCacheSource(), '');
        assert.equal(document.querySelectorAll('.sl_img_block img').length, 0);
        assert.equal(setGalleryCacheSource(keyFor('test')), true);
        scanner.scanAllMsgs();
        assert.deepEqual([...document.querySelectorAll('.sl_img_block img')].map(img => img.getAttribute('src')), ['/branch-a.png', '/branch-b.png']);
        const branchIds = [...document.querySelectorAll('.sl_img_btn')].map(btn => btn.dataset.slid);
        assert.ok(branchIds.every(id => !ids.includes(id)));
        assert.equal(calls, 4);
        assert.deepEqual(Object.keys(liveSession().gallery), ['/branch-a.png', '/branch-b.png']);
        document.querySelector('.sl_img_reanalyze').click();
        await waitUntil(() => document.querySelector('.sl_img_btn').dataset.prompt === 'Prompt 5.');
        scanner.scanAllMsgs();
        assert.equal(document.querySelectorAll('.sl_img_block img').length, 1);
        assert.equal(document.querySelector('.sl_img_block img').getAttribute('src'), '/branch-b.png');
    } finally {
        scanner.stopPolling(); ctx.chatId = original;
    }
});

test('chat filenames switch without normalization and roster copies can be edited or deleted independently', async () => {
    const { listCharacterChats, openCharacterSession } = await import('../modules/chat-sessions.js');
    const { copyRosterToCurrent, editRosterAnchor, deleteRosterPerson } = await import('../modules/roster.js');
    const oldOpen = ctx.openCharacterChat;
    const file = 'Tester - 2026-11-23 @ T10:00:00';
    const sourceKey = keyFor(file);
    try {
        sessionData(sourceKey, true).roster.Person = { anchor: 'eyes:green' };
        fetch = async () => ({ ok: true, json: async () => [{ file_name: file + '.jsonl' }] });
        let opened;
        ctx.openCharacterChat = async name => { opened = name; };
        const chats = await listCharacterChats();
        assert.equal(chats.find(chat => chat.key === sourceKey).label, file);
        assert.equal(await openCharacterSession(chats.find(chat => chat.key === sourceKey).file), true);
        assert.equal(opened, file);
        assert.equal(copyRosterToCurrent(sourceKey), 1);
        assert.equal(editRosterAnchor(keyFor('test'), 'Person', 'eyes:blue'), true);
        assert.equal(liveSession().roster.Person.anchor, 'eyes:blue');
        assert.equal(sessionData(sourceKey).roster.Person.anchor, 'eyes:green');
        assert.equal(deleteRosterPerson(keyFor('test'), 'Person'), true);
        assert.ok(sessionData(sourceKey).roster.Person);
    } finally { ctx.openCharacterChat = oldOpen; }
});

test('the archive page opens the exact current and historical sessions', async () => {
    const { createExpandedPanel } = await import('../modules/ui/panel.js');
    const { renderArchivePage } = await import('../modules/ui/tabs.js');
    const saved = { fetch, frame: globalThis.requestAnimationFrame };
    const historyFile = 'Tester - 2026-11-16 @ T08:00:00';
    const historyKey = keyFor(historyFile);
    try {
        sessionData(keyFor('test'), true).roster.Alice = { key: 'Alice', name: 'Alice', anchor: 'eyes:green', portraitViews: { front: '/existing.png' } };
        sessionData(historyKey, true).roster.Robin = { key: 'Robin', name: 'Robin', anchor: 'eyes:blue' };
        sessionData(sessionKey('other.png', 'test'), true).roster.Hidden = { key: 'Hidden', name: 'Hidden' };
        const before = JSON.stringify(archive.sessions);
        globalThis.requestAnimationFrame = callback => callback();
        fetch = async url => url === '/api/characters/chats'
            ? { ok: true, json: async () => [{ file_name: historyFile + '.jsonl' }] }
            : { ok: false, status: 404 };
        createExpandedPanel();
        renderArchivePage();
        const page = document.querySelector('.sl_page_body');
        assert.equal(page.querySelector('details[open] .sl_pcard').dataset.char, 'Alice');
        const history = () => [...page.querySelectorAll("details[data-chat]")].find(node => node.dataset.chat === historyKey);
        await waitUntil(history);
        assert.equal(history().open, false);
        assert.ok(history().querySelector('summary').textContent.includes(historyFile));
        history().open = true;
        history().querySelector('.sl_pcard').click();
        assert.equal(page.querySelector('.sl_anchor_input').value, 'eyes:blue');
        assert.equal(JSON.stringify(archive.sessions), before);
        assert.equal(page.textContent.includes("Hidden"), false);
    } finally {
        jQuery('#sl_panel_body').empty();
        fetch = saved.fetch; globalThis.requestAnimationFrame = saved.frame;
    }
});

test('the reading theme recolors complete cards and newly generated cards use matching secondary actions', async () => {
    const { createExpandedPanel } = await import('../modules/ui/panel.js');
    const { renderThemePage } = await import('../modules/ui/tabs.js');
    const { renderEnhancedLite, setEnqueueGen } = await import('../modules/render.js');
    const { refreshTextThemes } = await import('../modules/ui/theme.js');
    const { enqueueGen } = await import('../modules/queue.js');
    const saved = { fetch, theme: settings.enhancedTheme, frame: globalThis.requestAnimationFrame };
    const frame = document.createElement('iframe');
    document.body.append(frame);
    try {
        settings.enhancedTheme = '紧凑模式';
        globalThis.requestAnimationFrame = callback => callback();
        createExpandedPanel();
        renderThemePage();
        const picker = document.querySelector('#sl_text_theme');
        assert.equal(picker.value, '默认');
        assert.deepEqual([...picker.options].map(option => option.value), ['默认', '暖纸阅读', '深夜模式']);

        const source = '[img:场景]', enhanced = '[image:场景]【提示词】提示词【/提示词】';
        show(source);
        frame.contentDocument.body.textContent = source;
        let reanalyzed;
        for (const root of [document.querySelector('.mes_text'), frame.contentDocument.body])
            renderEnhancedLite(jQuery(root), enhanced, 'themed-card', source, false, index => { reanalyzed = index; });
        const card = document.querySelector('.sl_img_block');
        const framedCard = frame.contentDocument.querySelector('.sl_img_block');
        assert.equal(getComputedStyle(card).backgroundColor, 'rgb(245, 245, 247)');
        assert.equal(getComputedStyle(card.querySelector('.sl_img_title')).color, 'rgb(110, 110, 115)');
        for (const [theme, background, color] of [
            ['暖纸阅读', 'rgb(248, 232, 176)', 'rgb(20, 20, 20)'],
            ['深夜模式', 'rgb(24, 24, 24)', 'rgb(255, 255, 255)'],
        ]) {
            picker.value = theme;
            picker.dispatchEvent(new window.Event('change', { bubbles: true }));
            assert.equal(settings.enhancedTheme, theme);
            assert.equal(document.querySelector('.sl_img_block'), card);
            assert.equal(getComputedStyle(card).backgroundColor, background);
            assert.equal(getComputedStyle(card.querySelector('.sl_img_title')).color, color);
            assert.equal(frame.contentWindow.getComputedStyle(framedCard).backgroundColor, background);
        }

        fetch = async url => String(url).endsWith('/generate')
            ? { ok: true, json: async () => ({ data: 'AA==', format: 'png' }) }
            : { ok: true, json: async () => ({ path: '/theme-test.png' }) };
        setEnqueueGen(enqueueGen);
        card.querySelector('.sl_img_btn').click();
        await waitUntil(() => card.querySelector('.sl_img_result'));
        const assertGenerated = element => {
            const generate = element.querySelector('.sl_img_btn');
            const reanalyze = element.querySelector('.sl_img_reanalyze');
            assert.match(generate.textContent, /重新生成/);
            assert.equal(reanalyze.textContent, '重新解析');
            for (const button of [generate, reanalyze]) {
                const style = button.ownerDocument.defaultView.getComputedStyle(button);
                assert.equal(style.padding, '3px 6px');
                assert.equal(style.backgroundColor, 'rgba(0, 0, 0, 0)');
                assert.equal(style.color, 'rgb(255, 255, 255)');
            }
        };
        assertGenerated(card);
        card.querySelector('.sl_img_reanalyze').click();
        assert.equal(reanalyzed, 0);
        // Mount the saved image in the iframe through the same path used on a redraw.
        frame.contentDocument.body.textContent = source;
        renderEnhancedLite(jQuery(frame.contentDocument.body), enhanced, 'themed-card', source);
        assertGenerated(frame.contentDocument.querySelector('.sl_img_block'));
    } finally {
        frame.remove();
        jQuery('#sl_panel_body').empty();
        settings.enhancedTheme = saved.theme;
        refreshTextThemes();
        fetch = saved.fetch;
        globalThis.requestAnimationFrame = saved.frame;
    }
});

test('the compact panel and icon dock to the dragged edge across collapse and viewport changes', async t => {
    const { createCompactBar, setPluginEnabled } = await import('../modules/ui/compact-bar.js');
    const width = window.innerWidth, height = window.innerHeight;
    const oldPosition = localStorage.getItem('sl_compact_pos');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    function resize(w, h) {
        window.innerWidth = w; window.innerHeight = h;
        window.dispatchEvent(new window.Event('resize'));
    }
    try {
        resize(1000, 700);
        localStorage.setItem('sl_compact_pos', '{"x":18,"y":45}');
        createCompactBar();
        const bar = document.querySelector('#sl_compact');
        const header = bar.querySelector('#sl_comp_header');
        header.setPointerCapture = () => {};
        const left = () => parseFloat(bar.style.left);
        const right = () => left() + parseFloat(bar.style.width);
        const pointer = (target, type, x) => target.dispatchEvent(new window.PointerEvent(type, { pointerId: 1, clientX: x, clientY: 60 }));
        const move = (from, to) => {
            pointer(header, 'pointerdown', from);
            pointer(header, 'pointermove', to);
            pointer(header, 'pointerup', to);
        };
        const collapse = () => { t.mock.timers.tick(3000); assert.ok(bar.classList.contains('sl_compact_logo')); };
        const expand = () => { pointer(bar, 'pointerenter'); assert.ok(!bar.classList.contains('sl_compact_logo')); };

        assert.equal(left(), 18);
        collapse();
        assert.equal(left(), 18);
        expand();
        move(50, 40);
        assert.equal(left(), 0);
        pointer(bar, 'pointerleave');
        collapse();
        assert.equal(left(), 0);

        expand();
        move(30, 715);
        assert.equal(right(), 1000);
        pointer(bar, 'pointerleave');
        collapse();
        assert.equal(right(), 1000);
        const docked = localStorage.getItem('sl_compact_pos');
        resize(260, 150);
        assert.equal(right(), 260);
        expand();
        assert.equal(right(), 260);
        assert.ok(parseFloat(bar.style.top) + parseFloat(bar.style.height) <= 150);
        resize(1200, 800);
        assert.equal(right(), 1200);
        assert.equal(bar.style.top, '45px');
        assert.equal(localStorage.getItem('sl_compact_pos'), docked);
    } finally {
        setPluginEnabled(false);
        resize(width, height);
        if (oldPosition === null) localStorage.removeItem('sl_compact_pos');
        else localStorage.setItem('sl_compact_pos', oldPosition);
    }
});

for (const style of ['eventTypes', 'event_types']) test(style + ': generation lifecycle, late edits, swipe cache and rerender restoration', async () => {
    delete ctx.eventTypes; delete ctx.event_types; ctx[style] = types;

    let calls = 0;
    fetch = async () => response('画面提示词' + ++calls);
    const prefix = '保持同样开头'.repeat(20);
    show(prefix + '[img:红色场景]'); scanner.startPolling();
    try {
        eventSource.emit(types.GENERATION_STARTED, 'normal', {}, false);
        await scanner.runAuxImageScan(jQuery('.mes_text'));
        assert.equal(calls, 0);
        ctx.streamingProcessor = { isFinished: false, isStopped: false };
        eventSource.emit(types.GENERATION_ENDED);
        await scanner.runAuxImageScan(jQuery('.mes_text')); assert.equal(calls, 0);
        ctx.streamingProcessor.isFinished = true;
        await scanner.runAuxImageScan(jQuery('.mes_text'));
        await waitUntil(() => document.querySelector('.sl_img_btn'));
        assert.equal(calls, 1); const key = document.querySelector('.sl_img_btn').dataset.slid;
        // DOM redraw is independent from source revision, so restore without API.
        document.querySelector('.mes_text').textContent = ctx.chat[0].mes;
        scanner.scanAllMsgs(); assert.equal(document.querySelectorAll('.sl_img_btn').length, 1); assert.equal(calls, 1);
        ctx.chat[0].mes = prefix + '[img:蓝色场景]'; document.querySelector('.mes_text').textContent = ctx.chat[0].mes;
        await scanner.runAuxImageScan(jQuery('.mes_text')); await waitUntil(() => calls === 2 && document.querySelector('.sl_img_btn'));
        assert.notEqual(document.querySelector('.sl_img_btn').dataset.slid, key);
        ctx.chat[0].swipe_id = 1; document.querySelector('.mes_text').textContent = ctx.chat[0].mes;
        await scanner.runAuxImageScan(jQuery('.mes_text')); await waitUntil(() => calls === 3 && document.querySelector('.sl_img_btn'));
        assert.equal(document.querySelectorAll('.sl_img_btn').length, 1);
    } finally { scanner.stopPolling(); ctx.streamingProcessor = null; }
    assert.equal(eventSource.listenerCount(types.GENERATION_STARTED), 0);
});

test('late API result cannot update profiles/cache/DOM after chat switch', async () => {
    let release;
    show('[img:旧消息]'); scanner.startPolling();
    fetch = async () => new Promise(resolve => release = resolve);
    try {
        await scanner.runAuxImageScan(jQuery('.mes_text')); await waitUntil(() => release);
        ctx.chatId = 'new'; show('[img:新消息]'); eventSource.emit(types.CHAT_CHANGED);
        release(response('不应落地的旧提示词'));
        await waitUntil(() => !scanner.scanCoordinator.running);
        assert.equal(document.querySelectorAll('.sl_img_btn').length, 0);
        assert.equal(JSON.stringify(archive.sessions).includes('不应落地'), false);
    } finally { scanner.stopPolling(); ctx.chatId = 'test'; }
});

test('frontend tool calls/content arrays extract all narrative markers; original helper is restored', () => {
    const raw = { content: '', tool_calls: [{ function: { arguments: JSON.stringify({ narrative: '[img:甲][img:乙]' }) } }] };
    assert.equal(extractNarrativeText(raw), '[img:甲][img:乙]');
    assert.equal(extractNarrativeText({ content: [{ type: 'text', text: '[img:甲]' }, { type: 'text', text: '[img:乙]' }] }), '[img:甲]\n[img:乙]');
    const original = async () => '[img:甲]'; window.TavernHelper = { generate: original, generateRaw: original };
    initFrontendBridge(); assert.notEqual(window.TavernHelper.generate, original);
    stopFrontendBridge(); assert.equal(window.TavernHelper.generate, original); assert.equal(window.TavernHelper.generateRaw, original);
});

test('code examples with no renderable marker do not spend analysis requests', async () => {
    show('[img:仅代码示例]');
    document.querySelector('.mes_text').innerHTML = '<pre><code>[img:仅代码示例]</code></pre>';
    let calls = 0; fetch = async () => { calls++; return response('无用请求'); };
    scanner.startPolling();
    try { await scanner.runAuxImageScan(jQuery('.mes_text')); assert.equal(calls, 0); }
    finally { scanner.stopPolling(); }
});

test('ComfyUI request forwards the exact template except prompt and zero seed, with no mutation', async () => {
    const { generateImage } = await import('../modules/comfyui.js');
    const wf = '{\n"future":{"class_type":"FutureText","inputs":{"value":"%prompt%"}},"sampler":{"class_type":"KSamplerVariant","inputs":{"noise_seed":0,"fixed":18446744073709551615}},"negative":"keep %negative_prompt%"\n}';
    let sent;
    fetch = async (url, options) => {
        if (String(url).endsWith('/generate')) { sent = JSON.parse(options.body).prompt; return { ok: true, json: async () => ({ data: 'AA==', format: 'png' }) }; }
        return { ok: true, json: async () => ({ path: '/fixture.png' }) };
    };
    settings.stylePreset = ''; settings.animeArtist = '';
    const result = await generateImage(wf, '画面"换行\n$&');
    const payload = JSON.parse(sent);
    assert.equal(result.url, '/fixture.png');
    assert.equal(payload.prompt.future.inputs.value, '画面"换行\n$&');
    assert.ok(payload.prompt.sampler.inputs.noise_seed > 0);
    assert.ok(sent.includes('18446744073709551615')); assert.ok(sent.includes('keep %negative_prompt%'));
    assert.ok(wf.includes('"noise_seed":0'));
});

test('failed slots never borrow another prompt; successful slots are reused on retry', async () => {
    const results = new Map(); let calls = 0;
    fetch = async (_url, options) => {
        calls++;
        const user = JSON.parse(options.body).messages.find(m => m.role === 'user').content;
        return response(user.includes('失败场景') ? '（无）' : '成功场景独立提示词');
    };
    const source = '[img:成功场景][img:失败场景]';
    const first = await runRosterPipeline(source, 'partial', { results });
    assert.equal(first.ok, false); assert.equal(first.partial, true); assert.equal(results.size, 1);
    assert.ok(first.enhanced.includes('[img:失败场景]')); assert.equal(calls, 3);
    await runRosterPipeline(source, 'partial', { results });
    assert.equal(calls, 5); assert.equal(results.size, 1);
});

test('editing one marker retains other prompts, images and IDs after scanner restart', async () => {
    let calls = 0;
    fetch = async () => response('编辑回归提示词' + ++calls);
    const source = '前[img:相同]中[img:相同]后[img:尾图]';
    show(source); scanner.startPolling();
    try {
        await scanner.runAuxImageScan(jQuery('.mes_text'));
        await waitUntil(() => document.querySelectorAll('.sl_img_btn').length === 3 && !scanner.scanCoordinator.running);
        const original = Array.from(document.querySelectorAll('.sl_img_btn'), b => ({ id: b.dataset.slid, prompt: b.dataset.prompt }));
        galleryAdd('/first.png', { blockId: original[0].id }); galleryAdd('/third.png', { blockId: original[2].id });
        scanner.stopPolling(); scanner.startPolling(); // No in-memory revision map survives.
        ctx.chat[0].mes = source.replace('中[img:相同]', '中[img:新图]'); document.querySelector('.mes_text').textContent = ctx.chat[0].mes;
        await scanner.runAuxImageScan(jQuery('.mes_text'));
        await waitUntil(() => document.querySelectorAll('.sl_img_btn').length === 3 && !scanner.scanCoordinator.running);
        const updated = Array.from(document.querySelectorAll('.sl_img_btn'));
        assert.equal(calls, 4); assert.equal(updated[0].dataset.slid, original[0].id); assert.equal(updated[2].dataset.slid, original[2].id);
        assert.equal(updated[0].dataset.prompt, original[0].prompt); assert.equal(updated[2].dataset.prompt, original[2].prompt);
        assert.notEqual(updated[1].dataset.slid, original[1].id);
        assert.deepEqual(Array.from(document.querySelectorAll('.sl_img_block img'), i => i.getAttribute('src')), ['/first.png', '/third.png']);
        ctx.chat[0].mes += '仅改正文'; document.querySelector('.mes_text').textContent = ctx.chat[0].mes;
        await scanner.runAuxImageScan(jQuery('.mes_text')); await waitUntil(() => !scanner.scanCoordinator.running);
        assert.equal(calls, 4);
    } finally { scanner.stopPolling(); }
});

test('cancel image queue aborts active request, drops waiting/portrait tasks and requires explicit resume', async () => {
    const { enqueueGen, enqueueTask, clearQueue, getQueueStatus } = await import('../modules/queue.js');
    const { renderEnhancedLite, setEnqueueGen } = await import('../modules/render.js');
    const { imgCacheGetById } = await import('../modules/cache.js');
    show('[img:甲][img:乙]'); settings.autoGen = 1; setEnqueueGen(enqueueGen);
    let requests = 0, release, abortSignal, portraitError;
    fetch = async (url, options) => {
        if (String(url).endsWith('/generate')) {
            requests++; abortSignal = options.signal;
            return new Promise(resolve => release = () => resolve({ ok: true, json: async () => ({ data: 'AA==' }) }));
        }
        assert.fail('a cancelled result must not be uploaded');
    };
    const blocks = '[image:甲]【提示词】甲画面【/提示词】[image:乙]【提示词】乙画面【/提示词】';
    renderEnhancedLite(jQuery('.mes_text'), blocks, 'cancel-image-test', ctx.chat[0].mes, true);
    enqueueTask('portrait-cancel', '立绘', () => assert.fail('cancelled portrait succeeded'), error => portraitError = error);
    assert.deepEqual(getQueueStatus(), { queued: 2, running: true });
    assert.equal(clearQueue(), 3); assert.equal(abortSignal.aborted, true); assert.equal(portraitError.name, 'AbortError');
    // Simulate a server ignoring the disconnect and returning late.
    release(); await waitUntil(() => !getQueueStatus().running);
    await new Promise(r => setTimeout(r, 0));
    renderEnhancedLite(jQuery('.mes_text'), blocks, 'cancel-image-test', ctx.chat[0].mes, true);
    assert.equal(requests, 1); assert.equal(imgCacheGetById('cancel-image-test#0'), undefined);
    assert.equal(document.querySelectorAll('.sl_img_block img').length, 0);
    enqueueGen(jQuery('.sl_img_btn').first(), '手动继续'); assert.equal(requests, 2);
    clearQueue(); release(); await new Promise(r => setTimeout(r, 0)); settings.autoGen = 0;
});

test('H3 uses its own English overlay, preserves quoted lettering end to end, and keeps workflow geometry exact', async () => {
    const { MODES, isEnglishMode, isEnglishProseMode } = await import('../modules/settings.js');
    const { cleanPromptForMode } = await import('../modules/text-utils.js');
    const { extractImgBlocksFromEnhanced } = await import('../modules/render.js');
    const { generateImage, composeFinalPrompt } = await import('../modules/comfyui.js');
    const savedMode = settings.modelType; settings.modelType = 'minimax_h3_image';
    try {
        assert.equal(MODES.filter(m => m.id === settings.modelType).length, 1);
        assert.equal(isEnglishMode(), true); assert.equal(isEnglishProseMode(), true);
        const caption = 'A painted sign reads "Tester的茶铺" above the door. Her left hand supports the parcel while her right hand rests on its side.';
        let request;
        fetch = async (_url, options) => { request = JSON.parse(options.body); return response(caption); };
        const result = await runRosterPipeline('[img:茶铺|要点:手托包裹，招牌文字Tester的茶铺]', 'h3');
        const system = request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
        assert.ok(system.includes('【模式：MiniMax-H3-Image'));
        const { getPrompt } = await import('../prompts/loader.js');
        assert.ok(system.includes(getPrompt('pipeline/minimax-h3-image-overlay.txt').trim()));
        assert.equal(system.includes('【模式：Krea 2'), false);
        assert.ok(system.includes('a widescreen 16:9 composition'));
        assert.equal(system.includes('slightly taller-than-wide'), false);
        assert.equal(request.messages.at(-1).content.includes('a widescreen 16:9 composition'), false);
        const block = extractImgBlocksFromEnhanced(result.enhanced, 'h3')[0];
        assert.ok(block.prompt.includes('"Tester的茶铺"'));
        const cleaned = cleanPromptForMode(block.prompt, settings.modelType);
        assert.ok(composeFinalPrompt(cleaned).includes('"Tester的茶铺"'));
        const workflow = '{"text":{"inputs":{"text":"%prompt%"}},"canvas":{"inputs":{"width":1152,"height":1280}},"untouched":"%negative_prompt%"}';
        let sent;
        fetch = async (url, options) => {
            if (String(url).endsWith('/generate')) { sent = JSON.parse(JSON.parse(options.body).prompt); return { ok: true, json: async () => ({ data: 'AA==' }) }; }
            return { ok: true, json: async () => ({ path: '/h3-fixture.png' }) };
        };
        await generateImage(workflow, cleaned);
        assert.ok(sent.prompt.text.inputs.text.includes('"Tester的茶铺"'));
        assert.deepEqual(sent.prompt.canvas.inputs, { width: 1152, height: 1280 });
        assert.equal(sent.prompt.untouched, '%negative_prompt%');
    } finally { settings.modelType = savedMode; }
});

test('H3 retries caption JSON wrappers instead of forwarding them as image prompts', async () => {
    const savedMode = settings.modelType; settings.modelType = 'minimax_h3_image'; let calls = 0;
    try {
        fetch = async () => response(++calls === 1 ? '{"expanded_caption":"A natural portrait.","aspect_ratio":"1:1"}' : 'A natural portrait in a compact frame.');
        const result = await runRosterPipeline('[img:人像]', 'h3-json');
        assert.equal(result.ok, true); assert.equal(calls, 2);
        assert.ok(result.enhanced.includes('A natural portrait in a compact frame.'));
        assert.equal(result.enhanced.includes('aspect_ratio'), false);
    } finally { settings.modelType = savedMode; }
});

test('H3 mode cannot reuse another model prompt; edits within H3 still reuse unchanged slots', async () => {
    const savedMode = settings.modelType; settings.modelType = 'zit';
    let calls = 0; fetch = async () => response('Independent image caption ' + ++calls);
    show('[img:甲][img:乙]'); scanner.startPolling();
    try {
        await scanner.runAuxImageScan(jQuery('.mes_text')); await waitUntil(() => !scanner.scanCoordinator.running);
        const oldId = document.querySelector('.sl_img_btn').dataset.slid;
        settings.modelType = 'minimax_h3_image';
        await scanner.runAuxImageScan(jQuery('.mes_text')); await waitUntil(() => !scanner.scanCoordinator.running);
        const h3Id = document.querySelector('.sl_img_btn').dataset.slid;
        assert.equal(calls, 4); assert.notEqual(h3Id, oldId);
        ctx.chat[0].mes = '[img:甲][img:丙]'; document.querySelector('.mes_text').textContent = ctx.chat[0].mes;
        await scanner.runAuxImageScan(jQuery('.mes_text')); await waitUntil(() => !scanner.scanCoordinator.running);
        assert.equal(calls, 5); assert.equal(document.querySelector('.sl_img_btn').dataset.slid, h3Id);
        settings.modelType = 'zit'; ctx.chat[0].mes = '[img:甲][img:乙]'; document.querySelector('.mes_text').textContent = ctx.chat[0].mes;
        await scanner.runAuxImageScan(jQuery('.mes_text')); await waitUntil(() => !scanner.scanCoordinator.running);
        assert.equal(calls, 5); assert.equal(document.querySelector('.sl_img_btn').dataset.slid, oldId);
    } finally { scanner.stopPolling(); settings.modelType = savedMode; }
});

test('switching to H3 still restores historical images from another mode without generating them', async () => {
    const savedMode = settings.modelType; settings.modelType = 'zit';
    let calls = 0; fetch = async () => response('Historical image caption ' + ++calls);
    show('[img:历史图]'); scanner.startPolling();
    try {
        await scanner.runAuxImageScan(jQuery('.mes_text')); await waitUntil(() => !scanner.scanCoordinator.running);
        const oldId = document.querySelector('.sl_img_btn').dataset.slid; galleryAdd('/history.png', { blockId: oldId });
        ctx.chat.push({ mes: '新的回复，无图', is_user: false, swipe_id: 0 });
        document.querySelector('#chat').insertAdjacentHTML('beforeend', '<div class="mes" mesid="1"><div class="mes_text">新的回复，无图</div></div>');
        document.querySelector('.mes_text').textContent = ctx.chat[0].mes;
        settings.modelType = 'minimax_h3_image'; scanner.scanAllMsgs();
        assert.equal(calls, 1); assert.equal(document.querySelector('.sl_img_btn').dataset.slid, oldId);
        assert.equal(document.querySelector('.sl_img_block img').getAttribute('src'), '/history.png');
    } finally { scanner.stopPolling(); settings.modelType = savedMode; }
});

test('assembled requests keep shared policies, model overlays and per-call records in their own layers', async () => {
    const { MODES } = await import('../modules/settings.js');
    const { getPrompt } = await import('../prompts/loader.js');
    const { upsertPerson, setEnglishAnchor } = await import('../modules/roster.js');
    const { upsertEntry } = await import('../modules/wardrobe.js');
    const saved = { mode: settings.modelType, layered: settings.slPurgeLayered };
    const overlayPaths = { zit: 'zit', anima: 'anima', anime: 'anime', anime_tag: 'anime-tag', krea2: 'krea2', minimax_h3_image: 'minimax-h3-image' };
    const anchor = 'race:LayerTestOrigin | age:forty-two | nose:LayerTestNose | skin_tone:LayerTestTone';
    const detail = 'LayerTestBlue cotton jacket, LayerTestRound collar';
    const source = '[img:递出包裹|人物:LayerActor（层次测试）|造型:服装=LayerOutfit|要点:腰部以上，左手托住包裹]';
    let request;
    try {
        settings.modelType = 'minimax_h3_image';
        upsertPerson('LayerActor', '层次测试', '本轮档案原文', 'anchor');
        setEnglishAnchor('LayerActor', '层次测试', anchor);
        upsertEntry('服装', 'LayerOutfit', detail, 'expanded');
        fetch = async (_url, options) => { request = JSON.parse(options.body); return response('A waist-up view shows an adult supporting a parcel with the left hand.'); };
        for (const mode of MODES) for (const layered of [true, false]) {
            settings.modelType = mode.id; settings.slPurgeLayered = layered;
            const result = await runRosterPipeline(source, 'layer-audit');
            assert.equal(result.ok, true, mode.id);
            const systems = request.messages.filter(m => m.role === 'system'), system = systems.map(m => m.content).join('\n\n');
            const user = request.messages.at(-1).content;
            const overlay = getPrompt('pipeline/' + overlayPaths[mode.id] + '-overlay.txt').trim();
            const wardrobe = getPrompt('wardrobe-expand.txt').trim();
            assert.equal(system.split(overlay).length - 1, 1, 'one selected overlay: ' + mode.id);
            assert.ok(system.indexOf('## 造型库具象化') < system.indexOf(wardrobe));
            assert.ok(system.indexOf(wardrobe) < system.indexOf(overlay));
            assert.equal(system.includes(getPrompt('main-llm-instruction.txt').trim()), false, 'main-model instructions are a separate stage');
            if (layered) assert.ok(systems.some(m => m.content === overlay)); else assert.equal(systems.length, 1);
            assert.ok(user.includes('【人物档案】') && user.includes(anchor));
            assert.ok(user.includes('【造型库】') && user.includes(detail));
            assert.equal(system.includes(anchor) || system.includes(detail), false, 'records belong to the user payload');
            assert.equal(user.includes('只用光学与肤质词') || user.includes('重写四条 portrait'), false);
            if (mode.id === 'minimax_h3_image') {
                assert.doesNotMatch(overlay, /【人物档案】|【造型库】|\b(?:anchor|aura|portrait)\b|---(?:PROFILE|WARDROBE)---/);
                assert.equal(user.includes('【MiniMax-H3-Image】') || user.includes('标签区'), false);
            }
        }
    } finally {
        settings.modelType = saved.mode; settings.slPurgeLayered = saved.layered;
    }
});
