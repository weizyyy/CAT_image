// Safe, repeatable frontend checks. No model/ComfyUI requests, no chat mutation.
import { tokenizePlaceholders, messageKey } from './placeholders.js';
import { mountSlots, updateSlots } from './dom-placeholders.js';
import { randomizeZeroSeeds, substituteWorkflow } from './workflow-template.js';
import { clampPosition } from './ui/viewport.js';
import { ScanCoordinator } from './scan-coordinator.js';

export async function runSelfTest() {
    const checks = [];
    async function check(name, fn) {
        try { if (await fn() === false) throw new Error('assertion failed'); checks.push({ name, ok: true }); }
        catch (error) { checks.push({ name, ok: false, error: error.message }); }
    }
    await check('multiple-and-identical-placeholders', () => tokenizePlaceholders('[img:同景|甲][img:同景|乙]［IMG：夜景\n|道具:[花]］').length === 3);
    await check('whole-response-and-swipe-identity', () => {
        const prefix = '相同开头'.repeat(100);
        return messageKey('c', 1, prefix + '甲') !== messageKey('c', 1, prefix + '乙') && messageKey('c', 1, prefix, 0) !== messageKey('c', 1, prefix, 1);
    });
    await check('inline-dom-positions', () => {
        const root = document.createElement('div');
        root.innerHTML = '前[img:甲]中[img:<b>乙</b>]后';
        mountSlots(root, tokenizePlaceholders('前[img:甲]中[img:乙]后'), 'test');
        updateSlots(root, 'test', [{ html: '<b>A</b>' }, { html: '<b>B</b>' }]);
        return root.textContent === '前A中B后' && root.querySelectorAll('[data-sl-slot]').length === 2;
    });
    await check('iframe-owner-document', () => {
        const doc = document.implementation.createHTMLDocument('fixture'), root = doc.body;
        root.textContent = '[img:甲][img:乙]';
        mountSlots(root, tokenizePlaceholders(root.textContent), 'frame', [{ html: '<b>A</b>' }, { html: '<b>B</b>' }]);
        return root.textContent === 'AB' && root.firstElementChild.ownerDocument === doc;
    });
    await check('opaque-workflow-and-json-escaping', () => {
        const workflow = '{ "future": {"text":"%prompt%", "seed":18446744073709551615}, "negative":"%negative_prompt%" }';
        const prompt = '引号" 换行\n反斜线\\ $&';
        const out = substituteWorkflow(workflow, prompt);
        return JSON.parse(out).future.text === prompt && out.includes('18446744073709551615') && out.includes('%negative_prompt%');
    });
    await check('sampler-zero-only-randomization', () => {
        const workflow = '{ "1":{"class_type":"KSamplerAdvanced","inputs":{"noise_seed":0,"seed":["link",0]}},"2":{"class_type":"KSampler","inputs":{"seed":123}} }';
        return randomizeZeroSeeds(workflow, () => 456) === workflow.replace('"noise_seed":0', '"noise_seed":456');
    });
    await check('viewport-clamp', () => {
        const result = clampPosition(3000, 3000, 300, 198, { width: 320, height: 240 });
        return result.x === 20 && result.y === 42;
    });
    await check('stale-results-never-commit', async () => {
        let release, current = true, committed = false;
        const scheduler = new ScanCoordinator({ run: () => new Promise(r => release = r), commit: () => { committed = true; } });
        scheduler.submit({ key: 'old', owner: 'message', isCurrent: () => current });
        current = false; release({ ok: true });
        await new Promise(r => setTimeout(r, 0));
        return !committed;
    });
    const result = { ok: checks.every(c => c.ok), passed: checks.filter(c => c.ok).length, total: checks.length, checks };
    console.table(checks); return result;
}
