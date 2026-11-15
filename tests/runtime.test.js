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
