import { tokenizePlaceholders } from './placeholders.js';
import { mountSlots, updateSlots } from './dom-placeholders.js';
// ── SillyImage Lab 渲染 ──
import { slErr } from './log.js';
import { settings, escapeHtml, getActiveMode, isEnglishMode } from './settings.js';
import { applyTextTheme } from './ui/theme.js';

import { imgCacheGetById } from './cache.js';
import { extractImagePrompt, cleanPromptForMode } from './text-utils.js';

function imageActionLabel(generated) {
    return generated ? '↻ 重新生成' : '✦ 生成图片';
}

export function setImageActionState(button, state) {
    if (state) button.dataset.slState = state;
    else delete button.dataset.slState;
    button.textContent = state === 'queued' ? '排队中…' : state === 'error' ? '✕ 重试' :
        imageActionLabel(button.closest('.sl_img_block')?.hasAttribute('data-sl-generated'));
}

export function showGeneratedImage(button, url) {
    const card = button.closest('.sl_img_block');
    if (!card) return;
    let image = card.querySelector('.sl_img_result');
    if (!image) {
        image = card.ownerDocument.createElement('img');
        image.className = 'sl_img_result';
        button.before(image);
    }
    image.src = url;
    card.setAttribute('data-sl-generated', '');
    setImageActionState(button);
}

// ── 构造 img 卡片 HTML ──
export function buildImgCard(scene, fullPrompt, cachedImage, blockId, mode) {
    // [Fix] 短标题：详细字段只走生成链（【提示词】/data属性/缓存），不外显——
    // 标题取场景首句(≤14字)，提示词小字默认隐藏（设置 showGenPrompt 可开，调试用）
    var shortTitle = String(scene || '');
    var commaAt = shortTitle.search(/[，。！？、,;!?]/);
    if (commaAt > 0) shortTitle = shortTitle.slice(0, commaAt);
    var truncated = shortTitle.length > 14;
    if (truncated) shortTitle = shortTitle.slice(0, 14);
    var titleText = shortTitle + (truncated ? '…' : '');
    return '<div class="sl_img_block"' + (cachedImage ? ' data-sl-generated' : '') +
        ' style="--sl-image-width:' + escapeHtml(settings.imgBlockWidth || '55%') + '" title="' + escapeHtml(titleText) + '">' +
        '<div class="sl_img_title">🖼️ ' + escapeHtml(titleText) + '</div>' +
        (cachedImage ? '<img class="sl_img_result" src="' + escapeHtml(cachedImage) + '">' : '') +
        '<button type="button" class="sl_img_action sl_img_btn" data-prompt="' + escapeHtml(fullPrompt) + '"' +
        (blockId ? ' data-slid="' + escapeHtml(blockId) + '"' : '') + (mode ? ' data-sl-mode="' + escapeHtml(mode) + '"' : '') + '>' + imageActionLabel(cachedImage) + '</button>' +
        (blockId ? '<button type="button" class="sl_img_action sl_img_reanalyze">重新解析</button>' : '') +
        (settings.showGenPrompt && fullPrompt !== scene ? '<div class="sl_img_prompt">🐱 ' + escapeHtml(fullPrompt) + '</div>' : '') +
        '</div>';
}

// ── 绑定生图按钮（事件委托：绑定一次永久有效，不受 DOM 重建影响） ──
// [前端卡桥] 图卡可能落在酒馆助手的 iframe 文档里（重前端卡），
// 顶层 document 的委托收不到那里的 click → 按文档分别绑定。
const reanalysisHandlers = new WeakMap();

export function bindImageButtonsIn(doc) {
    if (!doc) return;
    applyTextTheme(doc);
    if (doc.__sl_imgbtn_bound) return;
    doc.__sl_imgbtn_bound = true;
    jQuery(doc).on('click', '.sl_img_reanalyze', function () {
        const slot = this.closest('[data-sl-slot]');
        for (let root = slot?.parentElement; root; root = root.parentElement) {
            const handler = reanalysisHandlers.get(root);
            if (handler) {
                handler(Number(slot.dataset.slSlot.slice(slot.dataset.slSlot.lastIndexOf('#') + 1)), this);
                return;
            }
        }
    });
    jQuery(doc).on('click', '.sl_img_btn', async function() {
        var btn = jQuery(this), prompt = btn.data('prompt');
        if (btn.text() === '排队中…') return;
        enqueueGen(btn, prompt);
    });
}
var _imgBtnBound = false;
function bindImageButtonsGlobal() {
    if (_imgBtnBound) return;
    _imgBtnBound = true;
    bindImageButtonsIn(document);
}
bindImageButtonsGlobal();
// 排队引用由 queue.js / index.js 提供，这里先声明
var _enqueueGen = null;
export function setEnqueueGen(fn) { _enqueueGen = fn; }
function enqueueGen(btn, prompt, options) { if (_enqueueGen) _enqueueGen(btn, prompt, options); else { slErr('enqueueGen 未初始化'); } }

export function extractImgBlocksFromEnhanced(enhancedText, blockKey, startIndex = 0, blockIds, mode = getActiveMode()) {
    var blocks = [];
    if (!enhancedText) return blocks;
    var re = /\[image:\s*([\s\S]*?)\]/g;
    var m;
    var blockIdx = startIndex;
    while ((m = re.exec(enhancedText)) !== null) {
        var scene = (m[1] || '').trim();
        // [Fix] 用正则匹配位置定位提示词（同场景多图不共用第一块，B4）
        var promptContent = extractImagePrompt(enhancedText, m[0], m.index) || '';
        // [Fix] 提示词只用【提示词】块内容（无则回退场景）：占位符配图场景是主 LLM 写的长叙事
        // （人物动作/表情/衣着），拼进提示词会把剧情文字+角色名喂给生图模型
        var fullPrompt = promptContent || scene;
        if (isEnglishMode(mode)) { var _c = cleanPromptForMode(fullPrompt, mode); if (_c) fullPrompt = _c; }
        var bid = blockIds?.[blockIdx] || (blockKey ? blockKey + '#' + blockIdx : '');
        blockIdx++;
        blocks.push({ scene: scene, prompt: fullPrompt, id: bid, html: buildImgCard(scene, fullPrompt, imgCacheGetById(bid), bid, mode) });
    }
    return blocks;
}

export function renderEnhancedLite(element, enhancedText, blockKey, sourceText, autoGenerate = false, onReanalyze, resolvedOnly = false) {
    const root = element?.[0];
    if (!root) return;
    if (onReanalyze) reanalysisHandlers.set(root, onReanalyze);
    const tokens = tokenizePlaceholders(sourceText ?? root.textContent);
    const blocks = Array.isArray(enhancedText) ? enhancedText : enhancedText ? extractImgBlocksFromEnhanced(enhancedText, blockKey) : null;
    mountSlots(root, tokens, blockKey, blocks, resolvedOnly);
    bindImageButtonsIn(root.ownerDocument);
    if (blocks) updateSlots(root, blockKey, blocks);
    if (autoGenerate && blocks && settings.autoGen === 1 && settings.pluginOn !== false) {
        for (const btn of root.querySelectorAll('.sl_img_btn')) {
            if (btn.textContent.includes('生成图片') && !btn.closest('.sl_img_block')?.querySelector('img')) enqueueGen(jQuery(btn), jQuery(btn).data('prompt'), { automatic: true });
        }
    }
    return Array.from(root.querySelectorAll('[data-sl-slot]')).some(n => n.dataset.slSlot.startsWith(blockKey + '#'));
}
