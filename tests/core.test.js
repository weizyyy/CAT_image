import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { tokenizePlaceholders, fingerprint, messageKey, replaceTokens } from '../modules/placeholders.js';
import { locateMarkers, mountSlots, updateSlots, resetSlots } from '../modules/dom-placeholders.js';
import { ScanCoordinator } from '../modules/scan-coordinator.js';
import { substituteWorkflow, workflowRequest, randomizeZeroSeeds } from '../modules/workflow-template.js';
import { clampPosition } from '../modules/ui/viewport.js';

test('all occurrences, repeated scenes, multiline/fullwidth and nested brackets retain source offsets', () => {
    const source = '前文[img:同一场景|要点:甲]\n中间[img:同一场景|要点:乙]\n［IMG：夜景\n|道具:[红花]］尾声';
    const tokens = tokenizePlaceholders(source);
    assert.equal(tokens.length, 3);
    assert.deepEqual(tokens.map(t => source.slice(t.start, t.end)), tokens.map(t => t.text));
    assert.equal(replaceTokens(source, tokens, ['A', 'B', 'C']), '前文A\n中间B\nC尾声');
    assert.equal(tokenizePlaceholders('[img:没写完 [img:完整]').length, 1);
    assert.equal(tokenizePlaceholders('[img:未闭合').length, 0);
});
test('edits after identical long prefix and swipe/chat identity never share keys', () => {
    const prefix = '相同的开头'.repeat(100);
    assert.notEqual(fingerprint(prefix + '甲'), fingerprint(prefix + '乙'));
    assert.notEqual(messageKey('chat', 1, prefix, 0), messageKey('chat', 1, prefix, 1));
    assert.notEqual(messageKey('chat', 1, prefix), messageKey('other', 1, prefix));
});
test('DOM positions survive multiple markers in one node and inline node splits', () => {
    const doc = new JSDOM('<main>开头[img:场景甲]中间[img:场<span>景乙</span>]结尾</main>').window.document;
    const root = doc.querySelector('main'), tokens = tokenizePlaceholders('开头[img:场景甲]中间[img:场景乙]结尾');
    assert.equal(locateMarkers(root).length, 2);
    assert.equal(mountSlots(root, tokens, 'key'), 2);
    updateSlots(root, 'key', [{ html: '<b>A</b>' }, { html: '<b>B</b>' }]);
    assert.equal(root.textContent, '开头A中间B结尾');
    assert.deepEqual(Array.from(root.querySelectorAll('[data-sl-slot]'), n => n.dataset.slSlot), ['key#0', 'key#1']);
    assert.equal(mountSlots(root, tokens, 'key'), 0);
    resetSlots(root);
    assert.equal(root.textContent, '开头[img:场景甲]中间[img:场景乙]结尾');
});
test('excluded code and mismatched markers never consume another image or append at end', () => {
    const doc = new JSDOM('<main><code>[img:示例]</code><p>[img:真实]</p><p>[img:旧消息]</p></main>').window.document;
    const root = doc.querySelector('main');
    assert.equal(mountSlots(root, tokenizePlaceholders('[img:不存在]'), 'wrong', [{ html: '<b>wrong</b>' }]), 0);
    assert.equal(mountSlots(root, tokenizePlaceholders('[img:真实]'), 'right', [{ html: '<b>right</b>' }]), 1);
    assert.equal(root.querySelector('code').textContent, '[img:示例]');
    assert.equal(root.querySelectorAll('p')[1].textContent, '[img:旧消息]');
});
test('a running old revision cannot overwrite a newer revision and queued messages are not lost', async () => {
    let release;
    const commits = [], runs = [];
    const c = new ScanCoordinator({ run: async s => { runs.push(s.key); if (s.key === 'old') await new Promise(r => release = r); return { ok: true }; }, commit: s => commits.push(s.key) });
    const job = key => ({ key, owner: key === 'other' ? 'second' : 'first', isCurrent: () => true });
    c.submit(job('old')); c.submit(job('new')); c.submit(job('new')); c.submit(job('other'));
    release();
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(runs, ['old', 'new', 'other']);
    assert.deepEqual(commits, ['new', 'other']);
});
test('switching chat while awaiting suppresses commit; failures are bounded', async () => {
    let current = true, release, commits = 0;
    const c = new ScanCoordinator({ run: () => new Promise(r => release = r), commit: () => commits++ });
    c.submit({ key: 'x', owner: 'x', isCurrent: () => current }); current = false; release({ ok: true });
    await new Promise(r => setTimeout(r, 0)); assert.equal(commits, 0);
    const fail = new ScanCoordinator({ run: async () => { throw new Error('offline'); }, commit() {} });
    const s = { key: 'x', owner: 'x', isCurrent: () => true };
    for (let i = 0; i < 5; i++) { const job = fail.submit(s); await new Promise(r => setTimeout(r, 0)); job.retryAt = 0; }
    assert.equal(fail.jobs.get('x').attempts, 3);
});
test('opaque workflows preserve unknown nodes, formatting, 64-bit integers and all non-prompt text', () => {
    const wf = '{\n "unknown": {"class_type":"FutureNode", "inputs":{"s":"%prompt%", "n":18446744073709551615}}, "fixed":"$& %negative_prompt%"\n}';
    const prompt = 'quote" slash\\ line\n $& %prompt%';
    const result = substituteWorkflow(wf, prompt);
    assert.equal(result, wf.split('%prompt%').join(JSON.stringify(prompt).slice(1, -1)));
    assert.equal(JSON.parse(result).unknown.inputs.s, prompt);
    assert.equal(substituteWorkflow('invalid JSON %prompt%', prompt).startsWith('invalid JSON'), true);
    assert.equal(workflowRequest(wf, prompt, 'id').includes('18446744073709551615'), true);
});
test('zero seeds alone randomize in sampler variants and modular noise; links and fixed seeds stay byte exact', () => {
    const wf = '{"a":{"class_type":"KSamplerAdvancedX","inputs":{"noise_seed":0,"seed":["up",0]}},"b":{"class_type":"Other","inputs":{"seed":0}},"c":{"class_type":"KSampler","inputs":{"seed":18446744073709551615}},"d":{"class_type":"RandomNoise","inputs":{"noise_seed":0}}}';
    let count = 40;
    const result = randomizeZeroSeeds(wf, () => ++count);
    assert.equal(result, wf.replace('"noise_seed":0', '"noise_seed":41').replace(/"noise_seed":0(?=}}}$)/, '"noise_seed":42'));
    assert.equal(randomizeZeroSeeds('broken {"seed":0}', () => 1), 'broken {"seed":0}');
    assert.notEqual(workflowRequest('{"a":{"class_type":"KSampler","inputs":{"seed":0}}}', 'p', 'id'), workflowRequest('{"a":{"class_type":"KSampler","inputs":{"seed":0}}}', 'p', 'id'));
});
test('saved and resized positions clamp on tiny/offset viewports, preserving valid zero', () => {
    assert.deepEqual(clampPosition(2000, -30, 300, 198, { width: 320, height: 400 }), { x: 20, y: 0 });
    assert.deepEqual(clampPosition(0, 0, 300, 198, { width: 200, height: 100, offsetLeft: 10, offsetTop: 20 }), { x: 10, y: 20 });
    assert.deepEqual(clampPosition(0, 0, 56, 56, { width: 600, height: 400 }), { x: 0, y: 0 });
});
