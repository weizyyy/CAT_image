import { chromium } from 'playwright-core';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
try {
    const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('tauri.localhost'));
    if (!page) throw new Error('TauriTavern WebView not found');
    console.log(JSON.stringify(await page.evaluate(async () => {
        const ctx = globalThis.SillyTavern?.getContext?.();
        return { title: document.title, version: window.SILLYLAB_VERSION, compact: !!document.querySelector('#sl_compact'),
            context: !!ctx, eventTypes: !!(ctx?.eventTypes || ctx?.event_types), loadedChat: !!ctx?.chat?.length,
            extensionScripts: Array.from(document.scripts).map(s => s.src).filter(s => /CAT_image\/index.js/.test(s)) };
    }), null, 2));
} finally { await browser.close(); }
