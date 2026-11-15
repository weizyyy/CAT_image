import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP(process.env.CAT_CDP_URL || 'http://127.0.0.1:9223');
const report = { application: 'TauriTavern', checks: [] };
let page, cdp, savedPosition;
try {
    page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('tauri.localhost'));
    if (!page) throw new Error('TauriTavern WebView not found');
    savedPosition = await page.evaluate(() => localStorage.getItem('sl_compact_pos'));
    const result = await page.evaluate(async () => {
        const base = '/scripts/extensions/third-party/CAT_image/';
        const diagnostics = await import(base + 'modules/diagnostics.js');
        const result = await diagnostics.runSelfTest();
        return { version: window.SILLYLAB_VERSION, ...result };
    });
    report.version = result.version;
    report.checks.push(...result.checks);
    if (result.version !== 'v1.29.0') throw new Error('Expected v1.29.0');
    const rect = () => page.evaluate(() => {
        const el = document.querySelector('#sl_compact'), r = el.getBoundingClientRect(), v = visualViewport;
        return { x: r.x, y: r.y, width: r.width, height: r.height, vw: v.width, vh: v.height, collapsed: el.classList.contains('sl_compact_logo'),
            inBounds: r.x >= -1 && r.y >= -1 && r.right <= v.width + 1 && r.bottom <= v.height + 1 };
    });
    await page.evaluate(() => document.querySelector('#sl_compact').dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' })));
    await page.waitForTimeout(3200);
    const logo = await rect();
    report.checks.push({ name: 'native-three-second-logo', ok: logo.collapsed && logo.width <= 58 && logo.inBounds, rect: logo });
    await page.evaluate(() => document.querySelector('#sl_compact').dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' })));
    const expanded = await rect();
    report.checks.push({ name: 'native-hover-expansion', ok: !expanded.collapsed && expanded.width > 56 && expanded.inBounds });
    cdp = await page.context().newCDPSession(page);
    for (const [width, height] of [[320, 240], [480, 640], [900, 400]]) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await page.evaluate(() => {
            const el = document.querySelector('#sl_compact'); el.style.left = '99999px'; el.style.top = '-99999px'; window.dispatchEvent(new Event('resize'));
        });
        const resized = await rect();
        report.checks.push({ name: 'native-viewport-' + width + 'x' + height, ok: resized.inBounds, rect: resized });
    }
    report.ok = report.checks.every(c => c.ok);
    console.log(JSON.stringify(report, null, 2));
    if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
    if (!report.ok) process.exitCode = 1;
} finally {
    if (cdp) { await cdp.send('Emulation.clearDeviceMetricsOverride'); await cdp.detach(); }
    if (page && savedPosition !== undefined) await page.evaluate(async saved => {
        if (saved == null) localStorage.removeItem('sl_compact_pos'); else localStorage.setItem('sl_compact_pos', saved);
        const compact = await import('/scripts/extensions/third-party/CAT_image/modules/ui/compact-bar.js'); compact.rebuildCompactBar();
    }, savedPosition);
    await browser.close();
}
