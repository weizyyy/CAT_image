import { workflowRequest } from './workflow-template.js';
// ── SillyImage Lab 🎨 ComfyUI连接 通信 ──
import { slLog } from './log.js';
import { settings, getSTHeaders, saveSettings, escapeHtml, getActiveMode, isEnglishMode, MOSS_IMAGE_MODE } from './settings.js';
import { uploadImageToST } from './cache.js';
import { getCharacterName } from './archive.js';
import { rosterEntries } from './roster.js';
import { krea2StylePrompt } from './style-presets.js';
import { parseMossLayout } from './moss-layout.js';

// [Fix] 提示词角色名过滤（最后防线）：LLM 偶发违规把角色名写进提示词，或 FACE 占位符残留。
// 角色名是生图模型无法理解的概念噪音，且会把名字当成画面元素画出来。
export function stripCharacterNames(prompt) {
    if (!prompt) return prompt;
    try {
        const names = new Set([getCharacterName(), 'User', ...rosterEntries().map(entry => entry.name)]);
        var changed = false;
        for (const nm of names) {
            if (!nm || nm.length < 2) continue;
            var re;
            try { re = new RegExp(nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'); } catch (e) { continue; }
            if (re.test(prompt)) { prompt = prompt.replace(re, ''); changed = true; }
        }
        if (changed) {
            prompt = prompt.replace(/[，,]\s*[，,]+/g, '，').replace(/[，,]\s*$/g, '').replace(/\s+/g, ' ').trim();
        }
    } catch (e) { /* 过滤失败不影响生成 */ }
    return prompt;
}
// 画风预设表
// key 只作 UI 显示名，**不再原样拼进提示词**。旧版 value 里带着
// 「Anime 赛璐璐：」这种分类冒号（会把"分类标签"喂给模型）、大段日文假名（中文编码器吃不下）、
// 以及 PBR物理级材质 / 超写实质感（高反射毒药词 → 皮肤变塑料）。
// 现在 value 一律是干净的媒介描述，且避开"发光/超写实"一类词。
export var STYLE_PRESETS = {
    '': '',
    '柯达金200胶片质感，暖黄色调，细腻胶片颗粒，复古写实质感': '柯达200胶片摄影质感，自然暖调色彩，细腻银盐颗粒，真实光学景深',
    '水墨写意画，宣纸质感，墨色浓淡晕染，大面积留白，东方写意意境': '传统水墨写意画，粗纹宣纸肌理，焦浓重淡清墨色晕染，枯笔飞白，构图疏朗留白',
    '水彩画风格，半透明叠色水痕，水彩纸纹理，自然晕染过渡': '透明水彩手绘插画，棉浆水彩纸纹理，湿画法自然水痕与边缘晕染，色彩清透柔和',
    '厚涂油画风格，刮刀笔触肌理，亚麻布纹理，厚重色彩堆叠': '古典油画厚涂质感，亚麻画布肌理，可见画笔与刮刀笔触堆叠，丰富冷暖色阶过渡',
    '铅笔素描风格，细腻排线塑造，黑白灰层次分明，素描纸质感，手绘质感': '石墨铅笔手绘素描，粗糙素描纸纹理，细腻交叉排线塑造体积，黑白灰调子层次分明',
    'Anime 赛璐璐：赛璐珞胶片质感，清晰黑色轮廓线，纯色平涂色块，硬边分层阴影': '日系赛璐璐动画风格，清晰利落的深色勾线，明快纯色平涂色块，硬边二分阴影',
    'Anime 日系轻小说：anime style，2D，赛璐璐上色，细腻线稿，柔光，精致眼部高光，通透清新': '日系轻小说插画风格，纤细干净线稿，清透赛璐璐叠加上色，柔和明暗过渡，清爽色彩',
    'Anime 日本动画：anime style，2D，cel shading，vibrant colors，clean lineart，anime key visual': '现代日本动画主视觉图风格，2D平面动画着色，干净利落线稿，饱满通透色彩，电影感构图',
    'Anime 精致平涂：日本アニメスタイル，セル画調，くっきり黒線，フラット彩色，鮮やかな色彩，ベタ塗り色面，クリーンな線画': '日系平面构成插画，干脆利落的黑线勾勒，高饱和扁平色块平涂，精简干净的阴影',
    'Anime 立体精致：日本アニメスタイル，厚塗り×セル画混合，立体感ある陰影，柔らかな明暗グラデーション，繊細な線画，透明感': '日系半厚涂插画风格，细腻线稿融合柔和体积光影，丰富色彩渐变与空气感',
    'monochrome manga style，black and white，screentone shading，ink lines，hand-drawn comic，speed lines，crosshatch，黑白漫画': '日本黑白漫画原稿风格，纯黑白墨线手绘，G笔强弱线条，网点纸阴影肌理，精细排线',
    'Anime Q版萌系：大头小身比例，圆润简洁线条，扁平化可爱造型，明快纯色块': 'Q版二头身萌系插画，圆润简洁勾线，扁平化可爱造型，明快柔和纯色填充',
    'Anime 2.5D立体：保留赛璐璐平涂色块边界，硬边分层阴影，低多边形立体造型': '三渲二卡通渲染风格，保留2D赛璐璐色块边界与硬边阴影，立体几何光影结构',
    '国风厚涂插画，工笔白描线稿，东方人物骨相，典雅国风配色，水墨质感厚涂': '东方国风半厚涂插画，细腻工笔白描勾线，传统矿物颜料典雅配色，丝帛画卷质感',
    '皮克斯卡通3D风格，柔和全局光照，次表面散射质感，哑光黏土质感，圆润卡通造型': '欧美动画电影3D角色造型，圆润几何体块，柔和漫反射光影，细腻哑光材质肌理',
    '写实3D渲染，PBR物理级材质，全局光照，真实织物与皮肤纹理，超写实质感': '次世代写实CG角色渲染，自然漫反射光照，真实织物纤维与自然皮肤微肌理，电影级景深',
    'Anime 昭和赛璐璐：粗黑硬朗轮廓线，复古低饱和配色，大块平涂填色，轻微胶片颗粒': '80年代昭和复古赛璐璐动画，手作感粗黑轮廓线，复古低饱和胶片配色，平涂色块与轻微胶片颗粒',
    'Anime 90年代少年漫：硬朗墨线，网点纸阴影质感，写实人物比例，手绘漫画质感': '90年代复古少年漫画彩页风格，硬朗手绘墨线，利落转折阴影，复古印刷色彩质感',
    'Anime 90年代魔法少女：大眼睛精致高光，柔和流畅线条，明亮复古配色，赛璐璐平涂': '90年代复古少女动画风格，纤细柔和线条，粉彩复古色调，经典赛璐璐平涂与柔和散景'
};


// 后端通信
async function comfyFetch(path, body) {
    var ctrl = new AbortController();
    var timer = setTimeout(function() { ctrl.abort(); }, 30000);
    var response;
    try {
        response = await fetch('/api/sd/comfy' + path, {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, getSTHeaders()),
            body: JSON.stringify(body || {}),
            signal: ctrl.signal
        });
    } catch (e) {
        clearTimeout(timer);
        throw new Error(e && e.name === 'AbortError' ? 'ComfyUI请求超时(30s)' : (e ? e.message : 'fetch失败'));
    }
    clearTimeout(timer);
    if (!response.ok) { var text = await response.text(); throw new Error(text.slice(0, 500)); }
    var text = await response.text();
    if (!text || !text.trim()) return { ok: true };
    try { return JSON.parse(text); } catch (e) { return text; }
}

export async function loadWorkflowList() {
    try {
        var data = await comfyFetch('/workflows');
        var selector = $('#sl_wf_sel');
        selector.empty();
        for (var name of data) {
            var sel = name === settings.cWfName ? ' selected' : '';
            selector.append('<option value="' + escapeHtml(name) + '"' + sel + '>' + escapeHtml(name) + '</option>');
        }
    } catch (e) { $('#sl_wf_sel').html('<option>📂 📂 加载失败</option>'); }
}

export async function loadWorkflow(name) {
    var data = await comfyFetch('/workflow', { file_name: name });
    var wf = typeof data === 'string' ? data : JSON.stringify(data);
    settings.cWf = wf;
    settings.cWfName = name;
    saveSettings();
    $('#sl_wf').val(wf);
    toastr.success('📂 加载好啦喵~ (｡•̀ᴗ-)✧  ' + name);
}

export async function saveWorkflow(name, wf) {
    settings.cWf = wf;
    settings.cWfName = name;
    saveSettings();
    await comfyFetch('/save-workflow', { file_name: name, workflow: wf });
}

export async function deleteWorkflow(name) {
    await comfyFetch('/delete-workflow', { file_name: name });
    if (settings.cWfName === name) {
        settings.cWfName = '';
    }
    saveSettings();
}

// ── 最终正向提示词组装──
// 目的：面板里"复制提示词"必须等于**实际发给 ComfyUI 的那一条**（走一遍真实管线，而不是只给裸提示词）
// 仅保留模型输出、画风和艺术家风格，不注入通用前缀或负面词。
export function composeFinalPrompt(prompt, curMode = getActiveMode()) {
    if (curMode === MOSS_IMAGE_MODE && String(prompt).trimStart().startsWith('{')) {
        const layout = parseMossLayout(prompt);
        if (!layout) throw new Error('MOSS-Image 布局格式不正确，请重新解析图卡');
        if (!settings.animeArtist?.trim()) return prompt.trim();
        layout.summary.caption += ', ' + settings.animeArtist.trim();
        return JSON.stringify(layout);
    }
    prompt = String(prompt || '')
        .replace(/\[image:[^\]]*\]/g, '')
        .replace(/【提示词[】:：]*/g, '').replace(/【\/提示词】/g, '')
        .replace(/【\s*💬[^\n]*/g, '')
        .replace(/\n\s*【[^】]*】/g, '\n')
        .trim();
    prompt = stripCharacterNames(prompt);
    var domVal = (jQuery('#sl_style_preset').length ? jQuery('#sl_style_preset').val() : '') || '';
    var stylePrefix = domVal || settings.stylePreset || '';
    if (stylePrefix && !STYLE_PRESETS[stylePrefix]) {
        var matched = null;
        for (var k in STYLE_PRESETS) {
            if (k.indexOf(stylePrefix.slice(0, 15)) >= 0 || stylePrefix.indexOf(k.slice(0, 15)) >= 0) { matched = k; break; }
        }
        if (matched) stylePrefix = matched;
    }
    if (stylePrefix && STYLE_PRESETS[stylePrefix] && (curMode === 'zit' || !curMode)) {
        prompt = STYLE_PRESETS[stylePrefix] + ' ' + prompt;
    }
    if (isEnglishMode(curMode) && settings.animeArtist) prompt = prompt + ', ' + settings.animeArtist;
    // Krea 2 风格锁定：画风是唯一自动拼接的前置内容。
    // 自动模式不插入风格。
    if (curMode === 'krea2') {
        var _stylePrompt = krea2StylePrompt(settings.krea2Style);
        if (_stylePrompt) prompt = _stylePrompt + ', ' + prompt;
    }
    return prompt;
}

export async function generateImage(workflow, prompt, { signal, mode = getActiveMode() } = {}) {
    signal?.throwIfAborted();
    // 最终组装（模型输出 / 画风预设 / 艺术家风格）——
    // 与面板"提示词"里显示的完全同源
    prompt = composeFinalPrompt(prompt, mode);
    slLog('🎨ComfyUI-prompt(' + prompt.length + '字):', prompt);

    var clientId = 'sl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    var raw = workflowRequest(workflow, prompt, clientId);
    var ctrl2 = new AbortController();
    const cancel = () => ctrl2.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    var timer2 = setTimeout(function() { ctrl2.abort(); }, (settings.cTimeout || 180) * 1000);
    var response, data;
    try {
        response = await fetch('/api/sd/comfy/generate', {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, getSTHeaders()),
            body: JSON.stringify({ url: settings.cUrl, prompt: raw }),
            signal: ctrl2.signal
        });
        if (!response.ok) { var errorText = await response.text(); throw new Error(errorText.slice(0, 800)); }
        data = await response.json();
    } catch (e) {
        signal?.throwIfAborted();
        throw new Error(e && e.name === 'AbortError' ? 'ComfyUI生成超时(' + ((settings.cTimeout || 180)) + 's)' : (e ? e.message : 'fetch失败'));
    } finally {
        clearTimeout(timer2); signal?.removeEventListener('abort', cancel);
    }
    signal?.throwIfAborted();
    if (!data.data) throw new Error('无输出');
    var dataUrl = 'data:image/' + (data.format || 'png') + ';base64,' + data.data;
    try {
        var path = await uploadImageToST(dataUrl, signal);
        signal?.throwIfAborted();
        slLog('图片已上传:', path);
        return { url: path };
    } catch (e) {
        signal?.throwIfAborted();
        slLog('上传到 ST 失败，降级使用 base64:', e.message);
        return { url: dataUrl };
    }
}
