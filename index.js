import { extension_settings, getContext } from '../../../extensions.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { loadPrompts } from './prompts/loader.js';
import { initSettings, loadPreferences, settings } from './modules/settings.js';
import { loadArchive } from './modules/archive.js';
import { slLog, slErr } from './modules/log.js';
import { buildUI } from './modules/ui.js';
import { setEnqueueGen } from './modules/render.js';
import { enqueueGen } from './modules/queue.js';
import { startPolling } from './modules/scanner.js';
import { refreshCoopCards } from './modules/sync-cards.js';
import { initFrontendBridge } from './modules/frontend-bridge.js';

window.SILLYLAB_VERSION = 'v2.2.0';
initSettings(getContext, extension_settings);
loadPreferences();
setEnqueueGen(enqueueGen);

SlashCommandParser.addCommandObject(SlashCommand.fromProps({
    name: 'sillylab',
    callback: () => document.querySelector('#sl_comp_panel_btn')?.click(),
}));

try {
    await loadArchive();
    await loadPrompts(new URL('prompts/', import.meta.url).href);
    buildUI(extension_settings);
    if (settings.pluginOn !== false) startPolling();
    initFrontendBridge();
    refreshCoopCards();
    slLog('CAT_image ' + window.SILLYLAB_VERSION + ' 已启动');
} catch (error) {
    slErr('CAT_image 启动失败: ' + error.message);
    globalThis.toastr?.error(error.message, 'CAT_image');
}
