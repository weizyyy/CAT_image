import { tokenizePlaceholders } from './placeholders.js';
import { mountSlots, updateSlots } from './dom-placeholders.js';
// ── SillyImage Lab 渲染 ──
import { slLog, slErr } from './log.js';
import { settings, COLORS, escapeHtml, getActiveMode, isEnglishMode } from './settings.js';

import { imgCacheGet, imgCacheGetById } from './cache.js';
import { extractImagePrompt, cleanPromptForMode, imgBlockHead } from './text-utils.js';
import { resolveFacePrompt } from './pipeline/profile.js';

// ── 构造 img 卡片 HTML ──
export function buildImgCard(scene, fullPrompt, cachedImage, blockId) {
    // [Fix] 短标题：详细字段只走生成链（【提示词】/data属性/缓存），不外显——
    // 标题取场景首句(≤14字)，提示词小字默认隐藏（设置 showGenPrompt 可开，调试用）
    var shortTitle = String(scene || '');
    var commaAt = shortTitle.search(/[，。！？、,;!?]/);
    if (commaAt > 0) shortTitle = shortTitle.slice(0, commaAt);
    var truncated = shortTitle.length > 14;
    if (truncated) shortTitle = shortTitle.slice(0, 14);
    var titleText = shortTitle + (truncated ? '…' : '');
    return '<div class="sl_img_block" style="margin:8px 0;padding:10px 12px;border-radius:10px;background:' + COLORS.card + ';border:1px solid ' + COLORS.line + ';" title="' + escapeHtml(titleText) + '">' +
        '<div style="font-size:11px;color:' + COLORS.sub + ';margin-bottom:4px;">🖼️ ' + escapeHtml(titleText) + '</div>' +
        (cachedImage ? '<img src="' + escapeHtml(cachedImage) + '" style="max-width:' + (settings.imgBlockWidth || '55%') + ';border-radius:12px;margin-top:6px;display:block;">' : '') +
        '<span class="sl_img_btn" data-prompt="' + escapeHtml(fullPrompt) + '"' + (blockId ? ' data-slid="' + escapeHtml(blockId) + '"' : '') + ' style="display:inline-block;padding:5px 14px;margin-top:4px;background:' + (cachedImage ? COLORS.card : COLORS.blue) + ';color:' + (cachedImage ? COLORS.text : '#fff') + ';border-radius:8px;cursor:pointer;font-size:11px;font-weight:600;">' + (cachedImage ? '\u21bb \u91cd\u65b0\u751f\u6210' : '\u2726 \u751f\u6210\u56fe\u7247') + '</span>' +
        (settings.showGenPrompt && fullPrompt !== scene ? '<div style="font-size:10px;color:#aeaeb2;font-family:Consolas,monospace;line-height:1.4;margin-top:6px;padding-top:4px;border-top:1px dotted ' + COLORS.line + ';word-break:break-all;">🐱 ' + escapeHtml(fullPrompt) + '</div>' : '') +
        '</div>';
}

// ── 已移除（v1.2）：renderEnhancedBodyHtml / renderBodyEnhanced / renderEnhanced ──
// 这三个是「画师模式」专用的标记式(正文###…结尾###)渲染器，全量重建消息 HTML。
// 导演模式只需原地替换 [img:] 占位符 → 统一走 renderEnhancedLite()，不再重建消息。

// ── 绑定生图按钮（事件委托：绑定一次永久有效，不受 DOM 重建影响） ──
// [v1.1.2 前端卡桥] 图卡可能落在酒馆助手的 iframe 文档里（重前端卡），
// 顶层 document 的委托收不到那里的 click → 按文档分别绑定。
export function bindImageButtonsIn(doc) {
    if (!doc || doc.__sl_imgbtn_bound) return;
    doc.__sl_imgbtn_bound = true;
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

// ── 恢复图片块（编辑后） ──
var _getChatId, _getSTContext, _restoringBlocks = false; // 从外部注入的函数
export function setRestoreDeps(getChatIdFn, getContextFn) { _getChatId = getChatIdFn; _getSTContext = getContextFn; }

export function restoreImageBlocks() {
    // Defer module lookup to avoid a scanner/render initialization cycle.
    return import('./scanner.js').then(m => m.scanAllMsgs()).catch(e => slErr('恢复图片失败: ' + e.message));
}

// ══════════════════════════════
// ── v2.4 轻量渲染（酒馆AI模式）：只替换 [img:…] 占位符为图卡，正文/状态栏原文 HTML 全部保留 ──
// 修复：旧 renderEnhanced 全量重建（escape+<br>）→ 文字挤成一坨、原文 HTML 结构（状态栏等）丢失
export function extractImgBlocksFromEnhanced(enhancedText, blockKey, startIndex = 0, blockIds) {
    var blocks = [];
    if (!enhancedText) return blocks;
    var re = /\[image:\s*([\s\S]*?)\]/g;
    var m;
    var blockIdx = startIndex;
    while ((m = re.exec(enhancedText)) !== null) {
        var scene = (m[1] || '').trim();
        // [Fix] 用正则匹配位置定位提示词（同场景多图不共用第一块，B4）
        var promptContent = extractImagePrompt(enhancedText, m[0], m.index) || '';
        // [Fix] 提示词只用【提示词】块内容（无则回退场景）：导演模式场景是主 LLM 写的长叙事
        // （人物动作/表情/衣着），拼进提示词会把剧情文字+角色名喂给生图模型
        var fullPrompt = resolveFacePrompt(promptContent || scene);
        if (isEnglishMode()) { var _c = cleanPromptForMode(fullPrompt, getActiveMode()); if (_c) fullPrompt = _c; }
        // [Fix] 旧缓存 key 兼容（644d40c 前缓存 key=scene+', '+prompt），否则刷新后需重新生成
        var bid = blockIds?.[blockIdx] || (blockKey ? blockKey + '#' + blockIdx : '');
        blockIdx++;
        blocks.push({ scene: scene, prompt: fullPrompt, id: bid, html: buildImgCard(scene, fullPrompt, (bid ? imgCacheGetById(bid) : imgCacheGet(fullPrompt)), bid) });
    }
    return blocks;
}

export function renderEnhancedLite(element, enhancedText, blockKey, sourceText) {
    const root = element?.[0];
    if (!root) return;
    const tokens = tokenizePlaceholders(sourceText ?? root.textContent);
    const blocks = Array.isArray(enhancedText) ? enhancedText : enhancedText ? extractImgBlocksFromEnhanced(enhancedText, blockKey) : null;
    mountSlots(root, tokens, blockKey, blocks);
    bindImageButtonsIn(root.ownerDocument);
    if (blocks) updateSlots(root, blockKey, blocks);
    if (blocks && settings.autoGen === 1 && settings.pluginOn !== false) {
        for (const btn of root.querySelectorAll('.sl_img_btn')) {
            if (btn.textContent.includes('生成图片')) enqueueGen(jQuery(btn), jQuery(btn).data('prompt'), { automatic: true });
        }
    }
    return Array.from(root.querySelectorAll('[data-sl-slot]')).some(n => n.dataset.slSlot.startsWith(blockKey + '#'));
}
