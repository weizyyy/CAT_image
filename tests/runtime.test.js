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
const ctx = { chat: [], chatId: 'test', characters: [{ data: { name: 'Tester' }, chat: 'test' }], characterId: 0,
    eventSource, eventTypes: types, getRequestHeaders: () => ({}), setExtensionPrompt() {} };
initSettings(() => ctx, {});
Object.assign(settings, getDefaults(), { cWf: '{}', auxUrl: 'http://analysis.local', auxModel: 'test', autoGen: 0, storyLib: false });
const { loadPrompts } = await import('../prompts/loader.js');
globalThis.fetch = async url => ({ ok: true, text: () => readFile(new URL('../prompts/' + String(url).split('?')[0], import.meta.url), 'utf8') });
await loadPrompts('');
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

for (const style of ['eventTypes', 'event_types']) test(style + ': generation lifecycle, late edits, swipe cache and rerender restoration', async () => {
    delete ctx.eventTypes; delete ctx.event_types; ctx[style] = types;
    settings.msgMap = {};
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
        assert.equal(Object.values(settings.msgMap).some(v => v.includes('不应落地')), false);
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

test('editing one marker retains other prompts, images and IDs, including after reload and v2 migration', async () => {
    const { imgCacheSetById } = await import('../modules/cache.js');
    for (const legacy of [false, true]) {
        settings.msgMap = {}; settings.msgMapTs = {}; let calls = 0;
        fetch = async () => response('编辑回归提示词' + ++calls);
        const source = '前[img:相同]中[img:相同]后[img:尾图]';
        show(source); scanner.startPolling();
        try {
            await scanner.runAuxImageScan(jQuery('.mes_text'));
            await waitUntil(() => document.querySelectorAll('.sl_img_btn').length === 3 && !scanner.scanCoordinator.running);
            const original = Array.from(document.querySelectorAll('.sl_img_btn'), b => ({ id: b.dataset.slid, prompt: b.dataset.prompt }));
            imgCacheSetById(original[0].id, '/first.png'); imgCacheSetById(original[2].id, '/third.png');
            if (legacy) {
                const key = scanner.readSnapshot(0).key, record = JSON.parse(settings.msgMap[key]);
                settings.msgMap[key] = JSON.stringify({ version: 2, source, swipe: 0, enhanced: record.enhanced });
            }
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
    }
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
    renderEnhancedLite(jQuery('.mes_text'), blocks, 'cancel-image-test', ctx.chat[0].mes);
    enqueueTask('portrait-cancel', '立绘', () => assert.fail('cancelled portrait succeeded'), error => portraitError = error);
    assert.deepEqual(getQueueStatus(), { queued: 2, running: true });
    assert.equal(clearQueue(), 3); assert.equal(abortSignal.aborted, true); assert.equal(portraitError.name, 'AbortError');
    // Simulate a server ignoring the disconnect and returning late.
    release(); await waitUntil(() => !getQueueStatus().running);
    await new Promise(r => setTimeout(r, 0));
    renderEnhancedLite(jQuery('.mes_text'), blocks, 'cancel-image-test', ctx.chat[0].mes);
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
        assert.ok(system.includes('slightly taller-than-wide'));
        assert.equal(request.messages.at(-1).content.includes('slightly taller-than-wide'), false);
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
    const savedMode = settings.modelType; settings.modelType = 'zit'; settings.msgMap = {}; settings.msgMapTs = {};
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
    const { imgCacheSetById } = await import('../modules/cache.js');
    const savedMode = settings.modelType; settings.modelType = 'zit'; settings.msgMap = {}; settings.msgMapTs = {};
    let calls = 0; fetch = async () => response('Historical image caption ' + ++calls);
    show('[img:历史图]'); scanner.startPolling();
    try {
        await scanner.runAuxImageScan(jQuery('.mes_text')); await waitUntil(() => !scanner.scanCoordinator.running);
        const oldId = document.querySelector('.sl_img_btn').dataset.slid; imgCacheSetById(oldId, '/history.png');
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
    const saved = { mode: settings.modelType, layered: settings.slPurgeLayered, roster: settings.roster, wardrobe: settings.wardrobe };
    const overlayPaths = { zit: 'zit', anima: 'anima', anime: 'anime', anime_tag: 'anime-tag', krea2: 'krea2', minimax_h3_image: 'minimax-h3-image' };
    const anchor = 'race:LayerTestOrigin | age:forty-two | nose:LayerTestNose | skin_tone:LayerTestTone';
    const detail = 'LayerTestBlue cotton jacket, LayerTestRound collar';
    const source = '[img:递出包裹|人物:LayerActor（层次测试）|造型:服装=LayerOutfit|要点:腰部以上，左手托住包裹]';
    let request;
    try {
        settings.roster = {}; settings.wardrobe = {}; settings.modelType = 'minimax_h3_image';
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
            assert.equal(system.includes(getPrompt('static-profile/system.txt').trim()), false, 'card scanning is a separate request');
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
        settings.roster = saved.roster; settings.wardrobe = saved.wardrobe;
    }
});
