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
Object.assign(settings, getDefaults(), { cWf: '{}', autoGen: 0,
    auxProfiles: [{ name: 'Test', format: 'openai', url: 'http://analysis.local', model: 'test' }] });
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

test('manual floor ranges recover missing historical markers, including unloaded floors, and preserve cached images', async () => {
    const { clearQueue, getQueueStatus } = await import('../modules/queue.js');
    const { imgCacheGetById } = await import('../modules/cache.js');
    const savedAuto = settings.autoGen;
    settings.autoGen = 0;
    const sources = ['前[img:甲]中[img:乙]后', '[img:用户]', '[img:未加载]', '[img:已出图]', '[img:已解析]', '[img:不应排图]', '最新文字'];
    ctx.chat = sources.map((mes, id) => ({ mes, is_user: id === 1 }));
    const chat = document.querySelector('#chat');
    const mount = id => chat.insertAdjacentHTML('beforeend', '<div class="mes" mesid="' + id + '"><div class="mes_text">' + sources[id] + '</div></div>');
    const row = id => chat.querySelector('.mes[mesid="' + id + '"]');
    chat.replaceChildren();
    for (const id of [0, 1, 3, 4, 5, 6]) mount(id);
    function save(id, blockId) {
        const revision = scanner.readSnapshot(id);
        revision.slots = [{ id: blockId, enhanced: '[image:缓存图]【提示词】cached prompt【/提示词】' }];
        scanner.saveImageRevision(revision);
    }
    save(3, 'already-generated');
    save(4, 'preanalyzed');
    galleryAdd('/cached-floor.png', { blockId: 'already-generated' });

    const analyses = [];
    let imageRequests = 0;
    fetch = async (url, options) => {
        if (String(url).includes('analysis.local')) {
            analyses.push(JSON.parse(options.body).messages.at(-1).content);
            return response('Floor test ' + analyses.length + '.');
        }
        if (String(url).endsWith('/generate')) {
            imageRequests++;
            return { ok: true, json: async () => ({ data: 'AA==', format: 'png' }) };
        }
        return { ok: true, json: async () => ({ path: '/manual-floor-' + imageRequests + '.png' }) };
    };
    scanner.startPolling();
    try {
        assert.throws(() => scanner.queueMessageFloors('4-2'), /从小到大/);
        assert.throws(() => scanner.queueMessageFloors('0,99'), /超出/);
        const result = scanner.queueMessageFloors('0,1-4,２');
        assert.deepEqual(result, { queued: 1, analysing: 2, skipped: 1, needsArtist: 0 });
        await waitUntil(() => imageRequests === 4 && !scanner.scanCoordinator.running && !getQueueStatus().running);
        assert.equal(analyses.length, 3);
        assert.deepEqual(analyses.map(request => ['甲', '乙', '未加载'].find(scene => request.includes(scene))), ['甲', '乙', '未加载']);
        assert.equal(row(0).querySelectorAll('.sl_img_result').length, 2);
        assert.equal(row(3).querySelector('.sl_img_result').getAttribute('src'), '/cached-floor.png');
        assert.equal(row(4).querySelectorAll('.sl_img_result').length, 1);
        assert.equal(row(1).querySelectorAll('.sl_img_block').length, 0);
        assert.equal(row(5).querySelectorAll('.sl_img_block').length, 0);
        assert.ok(imgCacheGetById(scanner.readSnapshot(2).key + '#0'));
        mount(2);
        scanner.scanAllMsgs();
        assert.equal(row(2).querySelectorAll('.sl_img_result').length, 1);
        assert.equal(scanner.queueMessageFloors('0,2-4').queued, 0);
        assert.equal(imageRequests, 4);
        eventSource.emit(types.GENERATION_STARTED, 'normal', {}, false);
        assert.throws(() => scanner.queueMessageFloors('0'), /等回复/);
    } finally {
        scanner.stopPolling();
        clearQueue();
        settings.autoGen = savedAuto;
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

test('historical card reanalysis works during a new reply without analyzing the active floor', async () => {
    const source = '开头[img:旧提示]中间[img:保留提示]结尾';
    show(source);
    const oldReply = document.querySelector('.mes_text');
    const requests = [];
    let finishReanalysis;
    fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body).messages.at(-1).content);
        if (requests.length === 3) await new Promise(resolve => { finishReanalysis = resolve; });
        return response('Scene number ' + requests.length + '.');
    };
    scanner.startPolling();
    try {
        await scanner.runAuxImageScan(jQuery(oldReply));
        await waitUntil(() => oldReply.querySelectorAll('.sl_img_btn').length === 2 && !scanner.scanCoordinator.running);
        const untouched = oldReply.querySelectorAll('.sl_img_btn')[1].dataset.slid;
        galleryAdd('/untouched.png', { blockId: untouched });
        scanner.scanAllMsgs();
        const retry = () => oldReply.querySelector('.sl_img_reanalyze');
        eventSource.emit(types.GENERATION_STARTED, 'continue', {}, false);
        retry().click();
        assert.equal(retry().disabled, false);
        assert.equal(requests.length, 2);
        eventSource.emit(types.GENERATION_ENDED);

        eventSource.emit(types.GENERATION_STARTED, 'normal', {}, false);
        retry().click();
        assert.equal(retry().disabled, true);
        ctx.chat.push({ mes: '[img:尚未结束]', is_user: false, swipe_id: 0 });
        document.querySelector('#chat').insertAdjacentHTML('beforeend', '<div class="mes" mesid="1"><div class="mes_text">[img:尚未结束]</div></div>');
        ctx.streamingProcessor = { messageId: 1, isFinished: false, isStopped: false };
        // Nested host generation starts must preserve in-flight retries on other floors.
        eventSource.emit(types.GENERATION_STARTED, 'continue', {}, false);
        await scanner.runAuxImageScan(jQuery('.mes[mesid="1"] .mes_text'));
        await waitUntil(() => !!finishReanalysis);
        finishReanalysis();
        await waitUntil(() => oldReply.querySelector('.sl_img_btn').dataset.prompt === 'Scene number 3.' && !scanner.scanCoordinator.running);
        assert.equal(scanner.generationBusy(), true);
        assert.equal(document.querySelector('.mes[mesid="1"] [data-sl-slot]'), null);
        ctx.streamingProcessor = null;
        eventSource.emit(types.GENERATION_ENDED);

        oldReply.textContent = source;
        scanner.scanAllMsgs();
        const buttons = oldReply.querySelectorAll('.sl_img_btn');
        assert.equal(buttons[0].dataset.prompt, 'Scene number 3.');
        assert.equal(buttons[1].dataset.slid, untouched);
        assert.equal(oldReply.querySelector('.sl_img_result').getAttribute('src'), '/untouched.png');
        assert.equal(requests.length, 3);
        assert.ok(requests[2].includes('旧提示'));
        assert.ok(!requests[2].includes('保留提示'));
    } finally {
        finishReanalysis?.();
        ctx.streamingProcessor = null;
        scanner.stopPolling();
    }
});

test('TavernHelper HTML copies and repeated mode switches leave one card per finished marker', async () => {
    const source = '[img:第一处]中间[img:第二处]结尾';
    show(source);
    const original = document.querySelector('.mes_text');
    original.innerHTML = '<p>' + source + '</p>';
    let requests = 0;
    fetch = async () => response('Scene number ' + ++requests + '.');
    const buttonsIn = root => [...root.querySelectorAll('.sl_img_btn')];
    scanner.startPolling();
    try {
        await scanner.runAuxImageScan(jQuery(original));
        await waitUntil(() => buttonsIn(original).length === 2 && !scanner.scanCoordinator.running);
        const ids = buttonsIn(original).map(button => button.dataset.slid);
        galleryAdd('/first.png', { blockId: ids[0] });
        galleryAdd('/second.png', { blockId: ids[1] });
        scanner.scanAllMsgs();

        for (let pass = 0; pass < 3; pass++) {
            // TavernHelper serializes .mes_text before hiding it and reparses the copy.
            const streamed = document.createElement('div');
            streamed.className = 'TH-streaming';
            streamed.innerHTML = original.innerHTML;
            const inactiveHtml = original.innerHTML;
            original.classList.add('hidden!');
            original.after(streamed);
            await waitUntil(() => streamed.hasAttribute('data-sl-active-stream') && buttonsIn(streamed).length === 2 &&
                buttonsIn(streamed).every(button => button.closest('[data-sl-slot]')));
            assert.equal(original.innerHTML, inactiveHtml);
            assert.deepEqual(buttonsIn(streamed).map(button => button.dataset.slid), ids);
            assert.deepEqual([...streamed.querySelectorAll('.sl_img_result')].map(img => img.getAttribute('src')),
                ['/first.png', '/second.png']);
            assert.equal(streamed.querySelector('p').lastChild.textContent, '结尾');
            const slot = buttonsIn(streamed)[0].closest('[data-sl-slot]');
            slot.after(slot.cloneNode(true));
            scanner.scanAllMsgs();
            assert.deepEqual(buttonsIn(streamed).map(button => button.dataset.slid), ids);

            // The old host may survive briefly while the original is shown again.
            const streamedHtml = streamed.innerHTML;
            streamed.style.display = 'none';
            original.classList.remove('hidden!');
            await waitUntil(() => !streamed.hasAttribute('data-sl-active-stream'));
            assert.equal(streamed.innerHTML, streamedHtml);
            assert.deepEqual(buttonsIn(original).map(button => button.dataset.slid), ids);
            streamed.remove();
        }
        const legacyCard = original.querySelector('.sl_img_block');
        const div = document.createElement('div');
        div.className = legacyCard.className;
        div.innerHTML = legacyCard.innerHTML;
        legacyCard.replaceWith(div);
        original.innerHTML = original.innerHTML;
        assert.ok(buttonsIn(original).some(button => !button.closest('[data-sl-slot]')));
        scanner.scanAllMsgs();
        assert.equal(buttonsIn(original).length, 2);
        assert.ok(buttonsIn(original).every(button => button.closest('[data-sl-slot]')));

        assert.equal(requests, 2);
    } finally {
        scanner.stopPolling();
    }
});

test('uncached historical replies reconcile their streaming surfaces while other message DOM keeps changing', async () => {
    show('这条历史楼层没有图片');
    const first = document.querySelector('.mes');
    const original = first.querySelector('.mes_text');
    const bodyHtml = '<p>' + original.textContent + '</p>';
    const streaming = [document.createElement('div'), document.createElement('div')];
    for (const copy of streaming) {
        copy.className = 'TH-streaming';
        copy.innerHTML = bodyHtml;
    }
    original.after(...streaming);
    ctx.chat.push({ mes: '较新的回复', is_user: false });
    document.querySelector('#chat').insertAdjacentHTML('beforeend', '<div class="mes" mesid="1"><div class="mes_text">较新的回复</div></div>');
    scanner.startPolling();
    const updates = setInterval(() => first.classList.toggle('changing'), 30);
    try {
        await waitUntil(() => streaming[0].hasAttribute('data-sl-active-stream'));
        assert.equal(streaming[1].hasAttribute('data-sl-active-stream'), false);
        streaming[0].style.display = 'none';
        await waitUntil(() => streaming[1].hasAttribute('data-sl-active-stream'));
        assert.equal(streaming[0].hasAttribute('data-sl-active-stream'), false);
        assert.equal(streaming[0].innerHTML, bodyHtml);
        assert.equal(streaming[1].innerHTML, bodyHtml);
    } finally {
        clearInterval(updates);
        scanner.stopPolling();
    }
});

test('a pending image follows its slot between a TavernHelper iframe and normal message text', async () => {
    const { setEnqueueGen } = await import('../modules/render.js');
    const { clearQueue, enqueueGen } = await import('../modules/queue.js');
    const source = '前文[img:栈桥]后文';
    show(source);
    const original = document.querySelector('.mes_text');
    const rendered = document.createElement('div');
    rendered.className = 'mes_streaming';
    rendered.innerHTML = '<iframe></iframe>';
    original.after(rendered);
    original.hidden = true;
    const frameBody = rendered.querySelector('iframe').contentDocument.body;
    frameBody.textContent = source;

    let analysisRequests = 0, imageRequests = 0, finishImage;
    fetch = async url => {
        if (String(url).includes('analysis.local')) {
            analysisRequests++;
            return response('A view from the pier.');
        }
        if (String(url).endsWith('/generate')) {
            imageRequests++;
            await new Promise(resolve => { finishImage = resolve; });
            return { ok: true, json: async () => ({ data: 'AA==', format: 'png' }) };
        }
        return { ok: true, json: async () => ({ path: '/pier.png' }) };
    };
    setEnqueueGen(enqueueGen);
    scanner.startPolling();
    try {
        await scanner.runAuxImageScan(jQuery(rendered));
        await waitUntil(() => frameBody.querySelector('.sl_img_btn') && !scanner.scanCoordinator.running);
        const button = frameBody.querySelector('.sl_img_btn'), id = button.dataset.slid;
        button.click();
        await waitUntil(() => finishImage);
        rendered.hidden = true;
        original.hidden = false;
        await waitUntil(() => original.querySelector('.sl_img_btn')?.dataset.slState === 'queued');
        assert.equal(frameBody.querySelector('.sl_img_btn'), button);
        assert.equal(original.querySelector('.sl_img_btn').dataset.slid, id);
        finishImage();
        await waitUntil(() => original.querySelector('.sl_img_result')?.getAttribute('src') === '/pier.png');

        original.hidden = true;
        rendered.hidden = false;
        await waitUntil(() => frameBody.querySelector('.sl_img_result')?.getAttribute('src') === '/pier.png');
        assert.equal(original.querySelector('.sl_img_result').getAttribute('src'), '/pier.png');
        assert.equal(frameBody.querySelector('.sl_img_btn').dataset.slid, id);
        assert.equal(analysisRequests, 1);
        assert.equal(imageRequests, 1);
    } finally {
        scanner.stopPolling();
        clearQueue();
        finishImage?.();
    }
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

test('the archive sorts chat titles and can delete an orphaned roster without touching the other chats or gallery', async () => {
    const { createExpandedPanel, popPage } = await import('../modules/ui/panel.js');
    const { renderArchivePage } = await import('../modules/ui/tabs.js');
    const saved = { fetch, confirm: globalThis.confirm };
    const olderFile = 'Tester - 2026-11-12 @ T10:00:00';
    const historyFile = 'Tester - 2026-11-16 @ T08:00:00';
    const historyKey = keyFor(historyFile);
    const emptyFile = 'Tester - 2026-11-20 @ T14:00:00';
    let returnChatList;
    try {
        sessionData(keyFor('test'), true).roster.Alice = { key: 'Alice', name: 'Alice', anchor: 'eyes:green', portraitViews: { front: '/existing.png' } };
        const orphan = sessionData(keyFor(olderFile), true);
        orphan.roster.June = { key: 'June', name: 'June', anchor: 'eyes:hazel' };
        orphan.gallery['/orphan.png'] = { url: '/orphan.png' };
        sessionData(historyKey, true).roster.Robin = { key: 'Robin', name: 'Robin', anchor: 'eyes:blue' };
        sessionData(sessionKey('other.png', 'test'), true).roster.Hidden = { key: 'Hidden', name: 'Hidden' };
        fetch = async url => {
            if (url !== '/api/characters/chats') return { ok: false, status: 404 };
            await new Promise(resolve => { returnChatList = resolve; });
            return { ok: true, json: async () => [historyFile, emptyFile].map(file => ({ file_name: file + '.jsonl' })) };
        };
        createExpandedPanel();
        renderArchivePage();
        const page = document.querySelector('.sl_page_body');
        const list = page.querySelector('[data-roster-context]');
        const current = list.querySelector(':scope > details');
        assert.equal(current.dataset.chat, keyFor('test'));
        assert.equal(current.open, true);
        assert.equal(current.querySelector('.sl_pcard').dataset.char, 'Alice');
        assert.equal(current.querySelector('.sl_roster_delete'), null);
        const other = () => page.querySelector('details.sl_other_chats');
        const historicalKeys = () => [...other().querySelectorAll(':scope > details[data-chat]')].map(node => node.dataset.chat);
        assert.equal(other().open, false);
        assert.equal(other().querySelector(':scope > summary').textContent, '其他');
        assert.deepEqual(historicalKeys(), [historyKey, keyFor(olderFile)]);
        const history = () => [...other().querySelectorAll("details[data-chat]")].find(node => node.dataset.chat === historyKey);
        assert.equal(history().open, false);
        assert.ok(history().querySelector('summary').textContent.includes(historyFile));
        other().querySelector('summary').click();
        returnChatList();
        await waitUntil(() => other().textContent.includes(emptyFile));
        assert.equal(other().open, true);
        assert.deepEqual(historicalKeys(), [keyFor(emptyFile), historyKey, keyFor(olderFile)]);
        assert.deepEqual([...history().querySelectorAll('.sl_chat_switch,.sl_roster_copy,.sl_roster_delete')].map(b => b.textContent),
            ['切换聊天', '复制档案到当前聊天', '删除本档案']);
        const older = [...other().querySelectorAll('details[data-chat]')].find(node => node.dataset.chat === keyFor(olderFile));
        older.querySelector('summary').click();
        const deleteButton = older.querySelector('.sl_roster_delete');
        globalThis.confirm = () => false;
        deleteButton.click();
        assert.ok(orphan.roster.June);
        globalThis.confirm = message => { assert.ok(message.includes(olderFile)); return true; };
        deleteButton.click();
        await waitUntil(() => !historicalKeys().includes(keyFor(olderFile)));
        assert.equal(other().open, true);
        assert.deepEqual(orphan.roster, {});
        assert.ok(orphan.gallery['/orphan.png']);
        assert.equal(archive.sessions[keyFor('test')].roster.Alice.anchor, 'eyes:green');
        const before = JSON.stringify(archive.sessions);
        history().querySelector('summary').click();
        history().querySelector('.sl_pcard').click();
        assert.equal(page.querySelector('.sl_anchor_input').value, 'eyes:blue');
        assert.equal(JSON.stringify(archive.sessions), before);
        assert.equal(page.textContent.includes("Hidden"), false);
    } finally {
        popPage();
        fetch = saved.fetch; globalThis.confirm = saved.confirm;
    }
});

test('the gallery folds historical chats under Other and still lets users select and clear their cache source', async () => {
    const { createExpandedPanel, popPage } = await import('../modules/ui/panel.js');
    const { renderGalleryPage } = await import('../modules/ui/tabs.js');
    const { galleryCacheSource } = await import('../modules/gallery.js');
    const savedFetch = fetch;
    const historyFile = 'Gallery branch';
    const historyKey = keyFor(historyFile);
    try {
        fetch = async () => ({ ok: true, json: async () => [{ file_name: historyFile + '.jsonl' }] });
        galleryAdd('/current.png');
        galleryAdd('/historical.png', { chatKey: historyKey });
        createExpandedPanel();
        renderGalleryPage();
        const page = document.querySelector('.sl_page_body');
        const other = () => page.querySelector('details.sl_other_chats');
        const historical = () => other().querySelector(':scope > details');
        const button = () => historical().querySelector('.sl_gallery_source');
        assert.equal(other().querySelector('summary').textContent, '其他');
        assert.equal(other().open, false);
        assert.equal(historical().open, false);
        assert.equal(historical().querySelector('summary').textContent, historyFile);
        assert.equal(page.querySelector('details[open] .sl_gal_img').dataset.url, '/current.png');

        other().querySelector('summary').click();
        historical().querySelector('summary').click();
        button().click();
        await waitUntil(() => button().getAttribute('aria-pressed') === 'true');
        assert.equal(galleryCacheSource(), historyKey);
        assert.equal(other().open, true);
        assert.equal(historical().open, true);
        button().click();
        await waitUntil(() => button().getAttribute('aria-pressed') === 'false');
        assert.equal(galleryCacheSource(), '');
        assert.equal(other().open, true);
    } finally {
        popPage();
        fetch = savedFetch;
    }
});

test('the reading theme recolors complete cards and newly generated cards use matching secondary actions', async () => {
    const { createExpandedPanel, popPage } = await import('../modules/ui/panel.js');
    const { renderThemePage } = await import('../modules/ui/tabs.js');
    const { renderEnhancedLite, setEnqueueGen } = await import('../modules/render.js');
    const { refreshTextThemes } = await import('../modules/ui/theme.js');
    const { enqueueGen } = await import('../modules/queue.js');
    const saved = { fetch, theme: settings.enhancedTheme };
    const frame = document.createElement('iframe');
    document.body.append(frame);
    try {
        settings.enhancedTheme = '紧凑模式';
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
            renderEnhancedLite(jQuery(root), enhanced, 'themed-card', source, { onReanalyze: index => { reanalyzed = index; } });
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
        popPage();
        settings.enhancedTheme = saved.theme;
        refreshTextThemes();
        fetch = saved.fetch;
    }
});

test('the compact panel and icon dock to the dragged edge across collapse and viewport changes', async t => {
    const { createCompactBar, removeCompactBar } = await import('../modules/ui/compact-bar.js');
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
        removeCompactBar();
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

test('cancel image queue sends native cancellation for the submitted job and drops local waiting tasks', async () => {
    const { enqueueGen, enqueueTask, clearQueue, getQueueStatus } = await import('../modules/queue.js');
    const { renderEnhancedLite, setEnqueueGen } = await import('../modules/render.js');
    const { imgCacheGetById } = await import('../modules/cache.js');
    show('[img:甲][img:乙]'); settings.autoGen = 1; setEnqueueGen(enqueueGen);
    const savedUrl = settings.cUrl;
    const localUrl = 'http://127.0.0.1:8188/comfy/';
    const remoteUrl = 'https://comfy.example.test/relay/api/';
    settings.cUrl = localUrl;
    let release, abortSignal, portraitError;
    const jobs = [], cancellations = [];
    fetch = async (url, options) => {
        if (String(url).endsWith('/generate')) {
            const request = JSON.parse(options.body);
            jobs.push({ url: request.url, id: JSON.parse(request.prompt).prompt_id });
            abortSignal = options.signal;
            return new Promise(resolve => release = () => resolve({ ok: true, json: async () => ({ data: 'AA==' }) }));
        }
        if (String(url).endsWith('/cancel')) {
            assert.equal(options.method, 'POST');
            assert.equal(options.signal.aborted, false);
            assert.notEqual(options.signal, abortSignal);
            cancellations.push(url);
            return cancellations.length < 3
                ? { ok: true, json: async () => ({ cancelled: cancellations.length === 2 }) }
                : { ok: false, status: 404 };
        }
        assert.fail('a cancelled result must not be uploaded');
    };
    const blocks = '[image:甲]【提示词】甲画面【/提示词】[image:乙]【提示词】乙画面【/提示词】';
    renderEnhancedLite(jQuery('.mes_text'), blocks, 'cancel-image-test', ctx.chat[0].mes, { autoGenerate: true });
    enqueueTask('portrait-cancel', '立绘', () => assert.fail('cancelled portrait succeeded'), error => portraitError = error);
    assert.deepEqual(getQueueStatus(), { queued: 2, running: true });
    settings.cUrl = remoteUrl;
    assert.equal(clearQueue(), 3); assert.equal(abortSignal.aborted, true); assert.equal(portraitError.name, 'AbortError');
    // Simulate a server ignoring the disconnect and returning late.
    release(); await waitUntil(() => cancellations.length === 2);
    await new Promise(r => setTimeout(r, 0));
    const localCancelUrl = localUrl + 'api/jobs/' + jobs[0].id + '/cancel';
    assert.match(jobs[0].id, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/);
    assert.equal(jobs[0].url, localUrl);
    assert.deepEqual(cancellations, [localCancelUrl, localCancelUrl]);
    renderEnhancedLite(jQuery('.mes_text'), blocks, 'cancel-image-test', ctx.chat[0].mes, { autoGenerate: true });
    assert.equal(jobs.length, 1); assert.equal(imgCacheGetById('cancel-image-test#0'), undefined);
    assert.equal(document.querySelectorAll('.sl_img_block img').length, 0);
    enqueueGen(jQuery('.sl_img_btn').first(), '手动继续'); assert.equal(jobs.length, 2);
    assert.equal(jobs[1].url, remoteUrl);
    assert.notEqual(jobs[1].id, jobs[0].id);
    clearQueue(); release(); await new Promise(r => setTimeout(r, 0));
    assert.equal(abortSignal.aborted, true);
    assert.deepEqual(cancellations, [localCancelUrl, localCancelUrl, remoteUrl + 'jobs/' + jobs[1].id + '/cancel']);
    settings.autoGen = 0;
    settings.cUrl = savedUrl;
});

const mossLayout = (caption, text) => ({
    summary: { meta: ['visual novel event CG'], canvas: 'single', caption },
    items: [
        { label: 'character', tags: ['black hair', 'olive coat'], caption: 'A courier holds a parcel', bbox: [-410, -100, 432, 620] },
        ...(text ? [{ label: 'text', caption: 'Small painted sign', text, bbox: [-300, -760, -220, -320] }] : []),
    ],
    bbox_coord_space: 'abs_centralized',
    bbox_format: 'yxyx',
});

const mossOverlays = { moss_image: 'moss-image', moss_image_free: 'moss-image-free' };

for (const [mode, overlayName] of Object.entries(mossOverlays)) test(mode + ': overlay and native layout reach the image button and workflow intact', async () => {
    const { MODES, isEnglishMode } = await import('../modules/settings.js');
    const { setEnqueueGen, extractImgBlocksFromEnhanced } = await import('../modules/render.js');
    const { enqueueGen, getQueueStatus } = await import('../modules/queue.js');
    const saved = { modelType: settings.modelType, animeArtist: settings.animeArtist, cWf: settings.cWf, mossWidth: settings.mossWidth };
    const cg = mode === 'moss_image';
    Object.assign(settings, { modelType: mode, animeArtist: cg ? 'ink and restrained cel shading' : '', mossWidth: 1600 });
    try {
        assert.equal(MODES.filter(m => m.id === settings.modelType).length, 1);
        assert.equal(isEnglishMode(), true);
        const caption = 'A courier supports a parcel with both hands in a rainlit station.';
        const text = 'Tester的茶铺\n"欢迎" <茶> [image:牌] 【/提示词】 ---END---';
        const layout = mossLayout(caption, text);
        if (!cg) delete layout.summary.meta;
        let request;
        fetch = async (_url, options) => { request = JSON.parse(options.body); return response(JSON.stringify(layout, null, 2)); };
        const result = await runRosterPipeline('[img:茶铺|要点:手托包裹，招牌文字Tester的茶铺]', 'moss');
        assert.equal(result.ok, true);
        const system = request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
        const { getPrompt } = await import('../prompts/loader.js');
        assert.ok(system.includes(getPrompt('pipeline/' + overlayName + '-overlay.txt').trim()));
        const otherName = cg ? mossOverlays.moss_image_free : mossOverlays.moss_image;
        assert.ok(!system.includes(getPrompt('pipeline/' + otherName + '-overlay.txt').trim()));
        assert.equal(system.includes('【模式：Krea 2'), false);
        assert.match(request.messages.at(-1).content, /实际宽 1600 px，高 864 px/);
        const blocks = extractImgBlocksFromEnhanced(result.enhanced, 'moss');
        assert.equal(blocks.length, 1);
        assert.deepEqual(JSON.parse(blocks[0].prompt), layout);
        settings.cWf = '{"text":{"inputs":{"text":"%prompt%"}},"canvas":{"inputs":{"width":1600,"height":864}},"untouched":"%negative_prompt%"}';
        let sent;
        fetch = async (url, options) => {
            if (String(url).endsWith('/generate')) { sent = JSON.parse(JSON.parse(options.body).prompt); return { ok: true, json: async () => ({ data: 'AA==' }) }; }
            return { ok: true, json: async () => ({ path: '/moss-fixture.png' }) };
        };
        setEnqueueGen(enqueueGen);
        document.querySelector('#chat').innerHTML = blocks[0].html;
        document.querySelector('.sl_img_btn').click();
        await waitUntil(() => document.querySelector('.sl_img_result') && !getQueueStatus().running);
        if (cg) layout.summary.caption += ', ' + settings.animeArtist;
        assert.deepEqual(JSON.parse(sent.prompt.text.inputs.text), layout);
        assert.deepEqual(sent.prompt.canvas.inputs, { width: 1600, height: 864 });
        assert.equal(sent.prompt.untouched, '%negative_prompt%');
    } finally { Object.assign(settings, saved); }
});

test('the free-style MOSS slot retries bad coordinates and leaves the marker untouched if it still receives prose', async () => {
    const savedMode = settings.modelType; settings.modelType = 'moss_image_free'; let calls = 0;
    try {
        const layout = mossLayout('A painted courier scene.');
        const bad = structuredClone(layout);
        bad.items[0].bbox[2] = 500;
        fetch = async (_url, options) => {
            if (++calls === 1) return response(JSON.stringify(bad));
            assert.match(JSON.parse(options.body).messages.at(-1).content, /原生 MOSS-Image Layout JSON/);
            return response(JSON.stringify(layout));
        };
        const source = '[img:人像]';
        const result = await runRosterPipeline(source, 'moss-json');
        assert.equal(result.ok, true); assert.equal(calls, 2);
        assert.ok(result.enhanced.includes(JSON.stringify(layout)));
        fetch = async () => { calls++; return response('A standalone paragraph instead of the required layout.'); };
        const rejected = await runRosterPipeline(source, 'moss-prose');
        assert.equal(rejected.ok, false);
        assert.equal(rejected.enhanced, source);
        assert.equal(calls, 4);
    } finally { settings.modelType = savedMode; }
});

test('the MOSS slots have distinct cached prompts and preserve unchanged image slots after editing', async () => {
    const savedMode = settings.modelType; settings.modelType = 'moss_image';
    let calls = 0; fetch = async () => response(JSON.stringify(mossLayout('Independent layout ' + ++calls)));
    show('[img:甲][img:乙]'); scanner.startPolling();
    try {
        await scanner.runAuxImageScan(jQuery('.mes_text')); await waitUntil(() => !scanner.scanCoordinator.running);
        const oldId = document.querySelector('.sl_img_btn').dataset.slid;
        settings.modelType = 'moss_image_free';
        await scanner.runAuxImageScan(jQuery('.mes_text')); await waitUntil(() => !scanner.scanCoordinator.running);
        const mossId = document.querySelector('.sl_img_btn').dataset.slid;
        assert.equal(calls, 4); assert.notEqual(mossId, oldId);
        ctx.chat[0].mes = '[img:甲][img:丙]'; document.querySelector('.mes_text').textContent = ctx.chat[0].mes;
        await scanner.runAuxImageScan(jQuery('.mes_text')); await waitUntil(() => !scanner.scanCoordinator.running);
        assert.equal(calls, 5); assert.equal(document.querySelector('.sl_img_btn').dataset.slid, mossId);
        settings.modelType = 'moss_image'; ctx.chat[0].mes = '[img:甲][img:乙]'; document.querySelector('.mes_text').textContent = ctx.chat[0].mes;
        await scanner.runAuxImageScan(jQuery('.mes_text')); await waitUntil(() => !scanner.scanCoordinator.running);
        assert.equal(calls, 5); assert.equal(document.querySelector('.sl_img_btn').dataset.slid, oldId);
    } finally { scanner.stopPolling(); settings.modelType = savedMode; }
});

test('a historical image from another mode restores from cache and can be reanalyzed in the current mode', async () => {
    const savedMode = settings.modelType; settings.modelType = 'zit';
    let calls = 0; fetch = async () => response('Historical image caption ' + ++calls);
    show('[img:历史图]'); scanner.startPolling();
    try {
        await scanner.runAuxImageScan(jQuery('.mes_text')); await waitUntil(() => !scanner.scanCoordinator.running);
        const oldId = document.querySelector('.sl_img_btn').dataset.slid; galleryAdd('/history.png', { blockId: oldId });
        ctx.chat.push({ mes: '新的回复，无图', is_user: false, swipe_id: 0 });
        document.querySelector('#chat').insertAdjacentHTML('beforeend', '<div class="mes" mesid="1"><div class="mes_text">新的回复，无图</div></div>');
        document.querySelector('.mes_text').textContent = ctx.chat[0].mes;
        settings.modelType = 'moss_image'; scanner.scanAllMsgs();
        assert.equal(calls, 1); assert.equal(document.querySelector('.sl_img_btn').dataset.slid, oldId);
        assert.equal(document.querySelector('.sl_img_block img').getAttribute('src'), '/history.png');
        const newLayout = mossLayout('Historical scene as a MOSS layout.');
        fetch = async () => { calls++; return response(JSON.stringify(newLayout)); };
        document.querySelector('.sl_img_reanalyze').click();
        await waitUntil(() => document.querySelector('.sl_img_btn').dataset.prompt === JSON.stringify(newLayout));
        assert.equal(document.querySelector('.sl_img_btn').dataset.slMode, 'moss_image');
        assert.equal(calls, 2);
        assert.notEqual(document.querySelector('.sl_img_btn').dataset.slid, oldId);
    } finally { scanner.stopPolling(); settings.modelType = savedMode; }
});

test('assembled requests keep shared policies, model overlays and per-call records in their own layers', async () => {
    const { MODES, isMossImageMode } = await import('../modules/settings.js');
    const { parseMossLayout } = await import('../modules/moss-layout.js');
    const { getPrompt } = await import('../prompts/loader.js');
    const { upsertPerson, setEnglishAnchor } = await import('../modules/roster.js');
    const { upsertEntry } = await import('../modules/wardrobe.js');
    const saved = { mode: settings.modelType, layered: settings.slPurgeLayered };
    const overlayPaths = { zit: 'zit', anima: 'anima', anime: 'anime', anime_tag: 'anime-tag', krea2: 'krea2', ...mossOverlays };
    const anchor = 'race:LayerTestOrigin | age:forty-two | nose:LayerTestNose | skin_tone:LayerTestTone';
    const detail = 'LayerTestBlue cotton jacket, LayerTestRound collar';
    const source = 'OUTSIDE_PLACEHOLDER [img:递出包裹|人物:LayerActor（层次测试）：右手戴着护腕|种子:ONE_FRAME_SEED|造型:服装=LayerOutfit；配饰=PendingOutfit|要点:腰部以上，左手托住包裹|事实:左腕装有护具]';
    let request;
    try {
        settings.modelType = 'moss_image';
        upsertPerson('LayerActor', '层次测试', '本轮档案原文', 'anchor');
        setEnglishAnchor('LayerActor', '层次测试', anchor);
        upsertEntry('服装', 'LayerOutfit', detail, 'expanded');
        fetch = async (_url, options) => {
            request = JSON.parse(options.body);
            const caption = 'A waist-up view shows a courier supporting a parcel with the left hand.';
            return response(isMossImageMode(settings.modelType) ? JSON.stringify(mossLayout(caption)) : caption);
        };
        for (const mode of MODES) for (const layered of [true, false]) {
            settings.modelType = mode.id; settings.slPurgeLayered = layered;
            const result = await runRosterPipeline(source, 'layer-audit');
            assert.equal(result.ok, true, mode.id);
            assert.doesNotMatch(result.enhanced, /LayerTestBlue cotton jacket|左腕装有护具/, 'omit outfit and facts without blocking a valid reply');
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
            assert.match(user, /待具象化[\s\S]*PendingOutfit/);
            assert.match(user, /人物段补充（LayerActor）：右手戴着护腕/);
            assert.match(user, /事实：左腕装有护具/);
            assert.equal(user.split('ONE_FRAME_SEED').length - 1, 1, 'one copy of the current seed');
            assert.doesNotMatch(user, /OUTSIDE_PLACEHOLDER|两段式|整轮只输出一次三段/);
            assert.match(system, /PROFILE → WARDROBE（有待具象化时）→ IMAGES → CHECK（可选）/);
            assert.equal(system.includes(anchor) || system.includes(detail), false, 'records belong to the user payload');
            assert.equal(user.includes('只用光学与肤质词') || user.includes('重写四条 portrait'), false);
            const layoutRules = getPrompt('pipeline/moss-image-layout.txt').trim();
            assert.equal(system.split(layoutRules).length - 1, Number(isMossImageMode(mode.id)));
            if (isMossImageMode(mode.id)) {
                assert.match(overlay, /^## 档案锚点 → character\.tags/m);
                assert.match(overlay, /^## 造型库 detail →/m);
                assert.doesNotMatch(overlay, /---(?:PROFILE|WARDROBE)---/);
                assert.ok(system.indexOf(layoutRules) < system.indexOf(overlay));
                assert.match(system, /两个模式的 Layout JSON 描述一律使用英文/);
                assert.match(overlay, /描述是否全为英文/);
                assert.match(user, /MOSS-Image Layout JSON 对象。描述一律使用英文/);
                assert.doesNotMatch(user, /第1条纯文本提示词/);
            }
        }
        for (const [mode, overlayName] of Object.entries(mossOverlays)) {
            const overlay = getPrompt('pipeline/' + overlayName + '-overlay.txt');
            const examples = overlay.split(/\r?\n/).filter(line => line.startsWith('{"summary"'));
            assert.equal(examples.length, 2, mode);
            for (const example of examples) {
                const layout = parseMossLayout(example, { width: 1536, height: 864 });
                assert.ok(layout, mode);
                assert.equal(layout.summary.meta !== undefined, mode === 'moss_image');
                const itemDescriptions = layout.items.map(({ text, ...fields }) => fields);
                assert.doesNotMatch(JSON.stringify([layout.summary, itemDescriptions]), /\p{Script=Han}/u, mode);
            }
        }
    } finally {
        settings.modelType = saved.mode; settings.slPurgeLayered = saved.layered;
    }
});

test('portrait editor persists the exact ComfyUI prompt and regenerates four views from the saved anchor', async () => {
    const { createExpandedPanel, popPage } = await import('../modules/ui/panel.js');
    const { renderArchivePage } = await import('../modules/ui/tabs.js');
    const { loadArchive, flushArchive } = await import('../modules/archive.js');
    const { getQueueStatus } = await import('../modules/queue.js');
    const savedSettings = { ...settings }, savedFetch = fetch;
    const files = new Map(), sent = [], requests = [];
    const views = {
        front: 'Standing, full body including feet, front view with blue eyes.',
        left: 'Standing, full body including feet, camera on her left side.',
        right: 'Standing, full body including feet, camera on her right side.',
        back: 'Standing, full body including feet, back view.',
    };
    let answer = { front: views.front };
    globalThis.fetch = async (url, options) => {
        if (String(url).startsWith('/user/files/')) {
            const data = files.get(url.split('/').at(-1));
            return data ? new Response(data) : new Response(null, { status: 404 });
        }
        if (url === '/api/files/upload') {
            const { name, data } = JSON.parse(options.body);
            files.set(name, Buffer.from(data, 'base64'));
            return new Response(null, { status: 200 });
        }
        if (url === '/api/characters/chats') return Response.json([]);
        if (url === '/api/images/upload') return Response.json({ path: '/portrait.png' });
        if (url === '/api/sd/comfy/generate') {
            sent.push(JSON.parse(JSON.parse(options.body).prompt).prompt.text);
            return Response.json({ data: 'AA==', format: 'png' });
        }
        assert.equal(url, 'http://analysis.local/chat/completions');
        requests.push(JSON.parse(options.body).messages.at(-1).content);
        return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] });
    };
    try {
        Object.assign(settings, { modelType: 'anima', animeArtist: 'fixture artist', cWf: '{"text":"%prompt%"}' });
        await loadArchive();
        const roster = sessionData(keyFor('test'), true).roster;
        roster.Alice = { key: 'Alice', name: 'Alice', anchor: 'age:twenty-eight | eyes:green' };
        roster.June = { key: 'June', name: 'June', anchor: 'age:about fourteen to fifteen years old | eyes:hazel' };
        createExpandedPanel();
        renderArchivePage();
        const page = document.querySelector('.sl_page_body');
        const el = selector => page.querySelector(selector);
        const openPerson = name => {
            el('.sl_pcard[data-char="' + name + '"]').click();
            el('.sl_prompt_btn').click();
        };
        openPerson('Alice');
        const input = () => el('.sl_prompt_ta');
        assert.equal(el('.sl_person_delete').nextElementSibling, el('.sl_prompt_btn'));
        assert.equal(el('.sl_prompt_btn').getAttribute('aria-expanded'), 'true');
        assert.deepEqual([...el('.sl_prompt_box').querySelectorAll('button')].filter(button => button.style.display !== 'none')
            .map(button => button.textContent), ['修改提示词', '重新生成']);
        const initial = input().value;
        assert.match(initial, /fixture artist$/);
        el('.sl_port_btn[data-view="front"]').click();
        await waitUntil(() => sent.length === 1 && !getQueueStatus().running);
        assert.equal(sent[0], initial);

        el('.sl_prompt_edit').click();
        const manual = ' Alice, 手改 "quoted" $&\nsecond line  ';
        input().value = manual;
        el('.sl_prompt_edit').click();
        assert.equal(await flushArchive(), true);
        const disk = await import('../modules/archive.js?portrait-reopened');
        await disk.loadArchive();
        assert.equal(disk.sessionData(keyFor('test')).roster.Alice.portraitPromptOverrides.anima, manual);
        el('.sl_pback').click();
        openPerson('Alice');
        assert.equal(input().value, manual);
        el('.sl_port_btn[data-view="front"]').click();
        await waitUntil(() => sent.length === 2 && !getQueueStatus().running);
        assert.equal(sent[1], manual);

        const newAnchor = 'age:twenty-eight | eyes:blue';
        el('.sl_anchor_input').value = newAnchor;
        const previousInput = input();
        el('.sl_anchor_save').click();
        await waitUntil(() => input() !== previousInput && !el('.sl_prompt_box').hidden);
        el('.sl_prompt_regenerate').click();
        await waitUntil(() => !el('.sl_prompt_regenerate').disabled);
        assert.equal(input().value, manual);
        assert.equal(roster.Alice.portraitPrompts, undefined);
        answer = views;
        el('.sl_prompt_regenerate').click();
        await waitUntil(() => !el('.sl_prompt_regenerate').disabled);
        assert.deepEqual(requests, [newAnchor, newAnchor]);
        assert.equal(sent.length, 2);
        assert.deepEqual(roster.Alice.portraitPrompts, { ...views, mode: 'anima' });
        assert.equal(Object.hasOwn(roster.Alice.portraitPromptOverrides, 'anima'), false);
        assert.match(input().value, /blue eyes.*fixture artist$/);
        el('.sl_port_btn[data-view="left"]').click();
        await waitUntil(() => sent.length === 3 && !getQueueStatus().running);
        assert.match(sent[2], /camera on her left side.*fixture artist$/);

        el('.sl_pback').click();
        openPerson('June');
        assert.equal(el('.sl_prompt_edit').disabled, true);
        assert.equal(el('.sl_prompt_regenerate').disabled, true);
        assert.match(input().value, /modest full coverage/);
    } finally {
        await flushArchive();
        popPage();
        Object.assign(settings, savedSettings);
        globalThis.fetch = savedFetch;
    }
});

test('OpenAI assistant sends standard fields, preserves legacy defaults and merges gateway parameters', async () => {
    const { auxApiCallRaw } = await import('../modules/pipeline/api.js');
    const original = { ...settings }, originalFetch = fetch;
    const requests = [];
    const messages = [{ role: 'system', content: 'first\nline' }, { role: 'system', content: 'second' },
        { role: 'user', content: 'request' }, { role: 'assistant', content: 'previous' }, { role: 'user', content: 'retry' }];
    try {
        fetch = async (url, options) => {
            requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
            if (requests.length === 1) return new Response('Unknown parameter: thinking', { status: 400 });
            return response('Fixture prompt.');
        };
        const profile = { name: 'Gateway', format: 'openai', url: 'https://gateway.invalid/v1/', key: 'gateway-test', model: 'fixture' };
        settings.auxProfiles = [profile];
        await auxApiCallRaw(messages, null, 16384, 0.25);
        assert.deepEqual(requests[0].body.thinking, { type: 'disabled' });
        assert.equal(requests[0].body.temperature, 0.25);
        assert.equal(requests[0].url, 'https://gateway.invalid/v1/chat/completions');
        assert.equal(requests[0].headers.Authorization, 'Bearer gateway-test');
        assert.deepEqual(requests[1].body, { messages, model: 'fixture', stream: false, temperature: 0.25, max_tokens: 16384 });

        profile.url = 'https://api.openai.com/v1/chat/completions';
        await auxApiCallRaw(messages, null, 16384, 0.25);
        assert.deepEqual(requests[2].body, { messages, model: 'fixture', stream: false, temperature: 0.25, max_completion_tokens: 16384 });
        profile.topK = '40';
        await assert.rejects(auxApiCallRaw(messages, null, 16384, 0.25), /topK/);

        profile.url = 'https://gateway.invalid/v1?route=fixture';
        Object.assign(profile, { temperature: '0', topP: '0.9', thinking: 'on', thinkingLevel: 'gateway-custom',
            omit: ['temperature'], additional: '"provider":{"only":["relace/fp4"],"allow_fallbacks":false}' });
        await auxApiCallRaw(messages, null, 16384, 0.25);
        assert.equal(requests[3].url, 'https://gateway.invalid/v1/chat/completions?route=fixture');
        assert.deepEqual(requests[3].body, { messages, model: 'fixture', stream: false, top_p: 0.9, top_k: 40,
            max_tokens: 16384, reasoning_effort: 'gateway-custom', provider: { only: ['relace/fp4'], allow_fallbacks: false } });
        profile.omit = ['thinkingLevel'];
        await auxApiCallRaw(messages, null, 16384, 0.25);
        assert.equal(requests[4].body.temperature, 0);
        assert.equal(Object.hasOwn(requests[4].body, 'reasoning_effort'), false);
        profile.additional = '{"messages":[]}';
        await assert.rejects(auxApiCallRaw(messages, null, 16384, 0.25), /messages/);
        assert.equal(requests.length, 5);
    } finally {
        Object.assign(settings, original);
        globalThis.fetch = originalFetch;
    }
});

test('Gemini uses projectless API-key requests for native single-image retries', async () => {
    const { auxApiCallRaw } = await import('../modules/pipeline/api.js');
    const original = { ...settings }, originalFetch = fetch;
    const requests = [];
    try {
        const profile = { name: 'Gemini', format: 'gemini', model: 'gemini-fixture', key: 'AIza-mock',
            temperature: '0', topP: '0.8', topK: '27', omit: ['topK'], thinking: 'on', thinkingLevel: 'low' };
        Object.assign(settings, { auxProfiles: [profile], modelType: 'zit', slPurgeLayered: true, nsfwEnhance: false });
        const captures = [
            { finishReason: 'STOP', content: { parts: [{ text: 'internal thought', thought: true },
                { text: '---IMAGES---\nA previous prompt.\n---END---' }] } },
            { finishReason: 'STOP', content: { parts: [{ text: '---PROFILE---\n{}\n---END---\n' },
                { text: 'another thought', thought: true }, { text: '---IMAGES---\nA final prompt.\n---END---' }] } },
            { finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'thought only', thought: true }] } },
        ];
        fetch = async (url, options) => {
            requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
            return Response.json({ candidates: [captures[requests.length - 1]] });
        };
        const end = await runRosterPipeline('前[img:测试场景]后', '0');
        assert.equal(end.ok, true);
        assert.match(end.enhanced, /A final prompt\./);
        assert.doesNotMatch(end.enhanced, /another thought/);
        assert.equal(requests.length, 2);
        const [first, retry] = requests;
        assert.equal(first.url, 'https://aiplatform.us.rep.googleapis.com/v1/publishers/google/models/gemini-fixture:generateContent?key=AIza-mock');
        assert.deepEqual(first.headers, { 'Content-Type': 'application/json' });
        assert.equal(retry.url, first.url);
        assert.deepEqual(first.body.generationConfig, { temperature: 0, topP: 0.8, maxOutputTokens: 16384, thinkingConfig: { thinkingLevel: 'LOW' } });
        assert.equal(first.body.systemInstruction.parts.length, 6);
        assert.deepEqual(retry.body.systemInstruction, first.body.systemInstruction);
        assert.equal(first.body.contents.length, 1);
        assert.deepEqual(retry.body.contents.map(item => item.role), ['user', 'model', 'user']);
        assert.deepEqual(retry.body.contents[0], first.body.contents[0]);
        assert.match(retry.body.contents[1].parts[0].text, /A previous prompt/);
        assert.doesNotMatch(retry.body.contents[1].parts[0].text, /internal thought/);

        Object.assign(profile, { key: 'new+key/&', thinkingLevel: '2048',
            url: 'https://us-central1-aiplatform.googleapis.com/v1/projects/old/locations/us-central1/publishers/google/models/old:generateContent?fixture=1&key=old-key' });
        const raw = await auxApiCallRaw('system', 'user');
        assert.deepEqual(raw, { content: '', finish: 'length', reasoningLen: 12, truncated: true });
        assert.equal(requests[2].url, 'https://us-central1-aiplatform.googleapis.com/v1/publishers/google/models/gemini-fixture:generateContent?fixture=1&key=new%2Bkey%2F%26');
        assert.deepEqual(requests[2].headers, { 'Content-Type': 'application/json' });
        assert.deepEqual(requests[2].body.generationConfig.thinkingConfig, { thinkingBudget: 2048 });
    } finally {
        Object.assign(settings, original);
        globalThis.fetch = originalFetch;
    }
});

test('Gemini keeps the query API key out of HTTP and network errors', async () => {
    const { testAuxConnection } = await import('../modules/pipeline/api.js');
    const { slLogDump } = await import('../modules/log.js');
    const original = { ...settings }, originalFetch = fetch;
    const key = 'secret-fixture+/&';
    const encoded = new URLSearchParams({ key }).toString();
    try {
        settings.auxProfiles = [{ name: 'Gemini', format: 'gemini', model: 'gemini-fixture', key }];
        fetch = async url => new Response(url + ' ' + key, { status: 403 });
        await assert.rejects(testAuxConnection(), error => error.message.includes('HTTP 403') &&
            !error.message.includes(key) && !error.message.includes(encoded));
        assert.equal(slLogDump().includes(key), false);
        assert.equal(slLogDump().includes(encoded), false);
        fetch = async url => { throw new Error('Failed to fetch ' + url); };
        await assert.rejects(testAuxConnection(), error => error.message.includes('Failed to fetch') &&
            !error.message.includes(encoded));
    } finally {
        Object.assign(settings, original);
        globalThis.fetch = originalFetch;
    }
});

test('assistant saves named connections, tests drafts and edits persistent fallback rows', async () => {
    const { fillSubPanel } = await import('../modules/ui/sub-panels.js');
    const { getAuxiliaryAttempts } = await import('../modules/settings.js');
    const original = { ...settings }, originalFetch = fetch;
    const body = jQuery('<div>').appendTo(document.body);
    const field = id => body.find('#sl_aux_' + id);
    const enter = (id, value) => field(id).val(value).trigger('change');
    try {
        settings.auxProfiles = [{ name: 'OpenAI', format: 'openai', url: 'https://open.invalid/v1', key: 'open-fixture', model: 'open-model' }];
        fillSubPanel('aux', body);
        assert.deepEqual(body.find('select,input,textarea').toArray().slice(0, 3).map(element => element.id),
            ['sl_aux_profile', 'sl_aux_name', 'sl_aux_format']);
        assert.equal(field('profile')[0].options[0].textContent, '连接策略');
        assert.equal(field('projectId').length, 0);
        assert.equal(field('level_row').prop('hidden'), true);
        enter('thinking', 'on');
        enter('thinkingLevel', 'custom');
        assert.equal(field('level_row').prop('hidden'), false);
        enter('temperature', '0.8');
        body.find('[data-aux-omit="temperature"]').prop('checked', true).trigger('change');
        assert.equal(field('temperature').prop('disabled'), true);
        enter('additional', '"provider":{"allow_fallbacks":False}');
        assert.equal(field('additional').attr('aria-invalid'), 'true');
        enter('additional', '"provider":{"allow_fallbacks":false}');
        assert.equal(field('additional').attr('aria-invalid'), 'false');
        assert.equal(getAuxiliaryAttempts()[0].config.thinkingLevel, undefined);
        body.find('#sl_save_aux')[0].click();
        assert.equal(getAuxiliaryAttempts()[0].config.thinkingLevel, 'custom');

        enter('profile', 'new');
        enter('name', 'Gemini');
        enter('format', 'gemini');
        assert.equal(field('projectId').length, 0);
        assert.equal(field('key').val(), '');
        assert.equal(field('additional').length, 0);
        enter('model', 'gemini-ui');
        enter('url', 'https://us-west1-aiplatform.googleapis.com/');
        enter('key', 'ui-api-key');
        enter('thinking', 'omit');
        assert.equal(getAuxiliaryAttempts()[0].config.model, 'open-model');
        const requests = [];
        fetch = async (url, options) => {
            requests.push({ url, body: JSON.parse(options.body) });
            return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'OK' }] } }] });
        };
        assert.equal(body.find('#sl_test_aux')[0].nextElementSibling.id, 'sl_save_aux');
        assert.equal(body.find('#sl_test_aux')[0].parentElement.nextElementSibling.id, 'sl_aux_status');
        body.find('#sl_test_aux')[0].click();
        await waitUntil(() => field('status').text() === '连接成功');
        assert.equal(requests[0].url, 'https://us-west1-aiplatform.googleapis.com/v1/publishers/google/models/gemini-ui:generateContent?key=ui-api-key');
        assert.equal(Object.hasOwn(requests[0].body.generationConfig, 'thinkingConfig'), false);
        body.find('#sl_save_aux')[0].click();
        assert.equal(getAuxiliaryAttempts()[0].config.model, 'gemini-ui');
        enter('profile', 'strategy');
        const rowNames = () => body.find('[data-aux-strategy-name]').toArray().map(row => row.value);
        const retries = () => body.find('[data-aux-strategy-retry]').toArray().map(row => row.checked);
        assert.deepEqual(rowNames(), ['Gemini']);
        assert.deepEqual(retries(), [true]);
        body.find('#sl_aux_add_strategy')[0].click();
        body.find('#sl_aux_add_strategy')[0].click();
        assert.deepEqual(rowNames(), ['Gemini', 'OpenAI', 'OpenAI']);
        body.find('[data-aux-strategy-name="2"]').val('Gemini').trigger('change');
        body.find('[data-aux-strategy-retry="0"]')[0].click();
        assert.deepEqual(getAuxiliaryAttempts().map(({ config, retry }) => [config.name, retry]),
            [['Gemini', false], ['OpenAI', true], ['Gemini', true]]);
        fillSubPanel('aux', body);
        assert.deepEqual(rowNames(), ['Gemini', 'OpenAI', 'Gemini']);
        assert.deepEqual(retries(), [false, true, true]);
        body.find('#sl_aux_reset_strategy')[0].click();
        assert.deepEqual(rowNames(), ['Gemini']);
        assert.deepEqual(retries(), [true]);
        assert.equal(settings.auxProfiles.length, 2);
        enter('profile', 'profile:OpenAI');
        assert.equal(field('model').val(), 'open-model');
        assert.equal(field('key').val(), 'open-fixture');
        assert.equal(field('thinkingLevel').val(), 'custom');
        assert.equal(field('temperature').val(), '0.8');
        assert.equal(field('temperature').prop('disabled'), true);
    } finally {
        body.remove();
        Object.assign(settings, original);
        globalThis.fetch = originalFetch;
    }
});

test('fallback strategy uses each profile in order and retries only the enabled row', async () => {
    const { flushArchive } = await import('../modules/archive.js');
    const original = { ...settings }, originalFetch = fetch;
    const calls = [];
    const source = '[img:回落测试]';
    try {
        Object.assign(settings, {
            auxProfiles: [
                { name: 'A', format: 'openai', url: 'https://a.invalid/v1', model: 'a' },
                { name: 'B', format: 'gemini', url: 'https://b.invalid', key: 'fixture-key', model: 'b' },
                { name: 'C', format: 'openai', url: 'https://c.invalid/v1', model: 'c' },
                { name: 'D', format: 'openai', url: 'https://d.invalid/v1', model: 'd' },
                { name: 'E', format: 'openai', url: 'https://e.invalid/v1', model: 'e' },
            ],
            auxUseStrategy: true, modelType: 'zit', slPurgeLayered: true,
            auxStrategy: ['A', 'B', 'C', 'D', 'E'].map(name => ({ name, retry: name !== 'A' })),
        });
        const bad = '---IMAGES---\nDraft from previous attempt.\n---END---';
        const blocked = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: bad }] } }] };
        fetch = async (url, options) => {
            if (url === '/api/files/upload') return new Response(null, { status: 200 });
            const host = new URL(url).hostname, payload = JSON.parse(options.body);
            calls.push({ host, payload });
            if (host === 'a.invalid') return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: bad } }] }));
            if (host === 'b.invalid') return Response.json(blocked);
            if (host === 'c.invalid') return new Response('Rate limit', { status: 429 });
            assert.equal(host, 'd.invalid');
            return response('Fallback image prompt.');
        };
        const result = await runRosterPipeline(source, '0');
        assert.equal(result.ok, true);
        assert.match(result.enhanced, /Fallback image prompt/);
        assert.deepEqual(calls.map(({ host }) => host), ['a.invalid', 'b.invalid', 'b.invalid', 'c.invalid', 'd.invalid']);
        assert.deepEqual(calls[1].payload.contents.map(({ role }) => role), ['user']);
        assert.deepEqual(calls[2].payload.contents.map(({ role }) => role), ['user', 'model', 'user']);
        assert.deepEqual(calls[4].payload.messages, calls[0].payload.messages);
        await flushArchive();

        const controller = new AbortController();
        calls.length = 0;
        fetch = async url => {
            calls.push(new URL(url).hostname);
            controller.abort();
            return new Response('Cancelled', { status: 503 });
        };
        assert.equal((await runRosterPipeline(source, '0', { signal: controller.signal })).ok, false);
        assert.deepEqual(calls, ['a.invalid']);
    } finally {
        Object.assign(settings, original);
        globalThis.fetch = originalFetch;
    }
});

test('exhausted fallback strategy waits for a manual retry instead of polling the same connection', async () => {
    const original = { ...settings }, originalFetch = fetch;
    try {
        show('[img:回落无可用输出]');
        settings.auxUseStrategy = true;
        settings.auxStrategy = [{ name: 'Test', retry: false }];
        let count = 0;
        fetch = async url => {
            if (url === '/api/files/upload') return new Response(null, { status: 200 });
            assert.equal(url, 'http://analysis.local/chat/completions');
            count++;
            return response('（无）');
        };
        scanner.startPolling();
        await scanner.runAuxImageScan(jQuery('.mes_text'));
        await waitUntil(() => !!document.querySelector('.sl_scan_retry'));
        const snapshot = scanner.readSnapshot(0);
        const job = scanner.scanCoordinator.jobs.get(snapshot.key);
        assert.equal(count, 1);
        assert.equal(job.state, 'failed');
        assert.equal(job.retryAt, Infinity);
        scanner.checkLastMessage();
        assert.equal(count, 1);
        document.querySelector('.sl_scan_retry').click();
        await waitUntil(() => count === 2 && !scanner.scanCoordinator.running);
    } finally {
        scanner.stopPolling();
        Object.assign(settings, original);
        globalThis.fetch = originalFetch;
    }
});
