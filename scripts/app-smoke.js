import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.connectOverCDP(process.env.CAT_CDP_URL || 'http://127.0.0.1:9223');
const report = { application: 'TauriTavern', checks: [] };
const fixtureOnly = process.env.CAT_FIXTURE_ONLY === '1';
let page, cdp, savedPosition, savedBridge;
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
    report.runningVersion = result.version;
    report.version = 'v' + (await page.evaluate(async () => (await (await fetch('/scripts/extensions/third-party/CAT_image/manifest.json?test=' + Date.now())).json()).version));
    report.checks.push(...result.checks);
    if (report.version !== 'v1.29.1' || (!fixtureOnly && result.version !== 'v1.29.1')) throw new Error('Expected v1.29.1');
    // Avoid the live host bridge intercepting the isolated fixture's helper.
    savedBridge = await page.evaluate(async () => {
        const { settings } = await import('/scripts/extensions/third-party/CAT_image/modules/settings.js');
        const saved = settings.feBridge; settings.feBridge = false; return saved !== false;
    });
    await page.evaluate(() => {
        const frame = document.createElement('iframe'); frame.name = 'cat_test_fixture';
        frame.style.cssText = 'position:fixed;width:480px;height:360px;left:-1000px;top:-1000px;';
        const jquery = Array.from(document.scripts).find(s => /jquery-[\d.]+\.min\.js/.test(s.src));
        if (!jquery) throw new Error('Host jQuery script not found');
        frame.srcdoc = '<script src="' + jquery.src + '"></script>'; document.body.appendChild(frame);
    });
    await page.waitForFunction(() => !!document.querySelector('iframe[name="cat_test_fixture"]')?.contentWindow?.jQuery);
    const fixtureFrame = page.frame({ name: 'cat_test_fixture' });
    await fixtureFrame.waitForFunction(() => !!window.jQuery);
    const fixture = await fixtureFrame.evaluate(async () => (await import('/scripts/extensions/third-party/CAT_image/tests/browser-fixture.js')).runBrowserFixture());
    report.checks.push(...fixture.checks); report.mockedAnalysisRequests = fixture.mockedAnalysisRequests;
    report.mockedImageRequests = fixture.mockedImageRequests;
    await page.evaluate(() => document.querySelector('iframe[name="cat_test_fixture"]')?.remove());
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
    if (!fixtureOnly) {
      const cancelButton = await page.evaluate(() => {
        const el = document.querySelector('#sl_comp_cancel'), r = el.getBoundingClientRect(), bar = document.querySelector('#sl_compact').getBoundingClientRect();
        return !!el && r.width > 0 && r.height > 0 && r.left >= bar.left && r.right <= bar.right && r.bottom <= bar.bottom;
    });
      report.checks.push({ name: 'native-expanded-cancel-button-visible-and-in-bounds', ok: cancelButton });
    }
    report.liveQueuePreserved = fixtureOnly;
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
        document.querySelector('iframe[name="cat_test_fixture"]')?.remove();
        if (saved == null) localStorage.removeItem('sl_compact_pos'); else localStorage.setItem('sl_compact_pos', saved);
        const compact = await import('/scripts/extensions/third-party/CAT_image/modules/ui/compact-bar.js'); compact.rebuildCompactBar();
    }, savedPosition);
    if (page && savedBridge !== undefined) await page.evaluate(async saved => {
        const { settings } = await import('/scripts/extensions/third-party/CAT_image/modules/settings.js'); settings.feBridge = saved;
    }, savedBridge);
    await browser.close();
}
