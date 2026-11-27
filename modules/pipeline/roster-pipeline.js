import { tokenizePlaceholders, replaceTokens } from '../placeholders.js';
// ── SillyImage Lab 协作管线（酒馆AI模式） ──
// 主LLM写正文+[img:]占位 → 插件AI按占位符与人物表写提示词 → 填回占位 → 走现有渲染/生成链
// 起为唯一管线（旧画师管线 runAuxPipeline 已移除）

import { slLog, slErr } from '../log.js';
import { settings, getActiveMode, isEnglishMode, isMossImageMode, MOSS_IMAGE_CG_MODE, MOSS_IMAGE_FREE_MODE, getMossCanvas } from '../settings.js';
import { parseMossLayout } from '../moss-layout.js';
import { auxApiCallRaw, withAuxiliaryFallback } from './api.js';
import { isPromptsLoaded, getPrompt } from '../../prompts/loader.js';
import { findImagePlaceholders, buildImageBlock, extractDynamicBits, findLostNumbers, wrapFactSpan, parseCheckSection } from '../text-utils.js';
import { rosterDataTextFor, rosterEntries, upsertPerson, applyPersonSegments, splitKnownPersonSegments, setEnglishAnchor, setZitAnchor, getAtomAnchor, atomValues, setPortraitPrompts } from '../roster.js';
import { saveArchive } from '../archive.js';
import { wardrobeDataTextFor, upsertEntry, normKey } from '../wardrobe.js';
import { krea2StyleById } from '../style-presets.js';

// ── 管线输出合格性判定（失败重试用）──
// 判定顺序：空 → 结构标记 → 拒绝语 → **条数** → 单条质量
// [Fix] 旧版只看"有没有 ---IMAGES--- 标记"，于是模型回 1 条（占位符 3 个）也算合格 →
//   不重试 → 剩下 2 条直接走中文场景兜底（就是用户看到的"没重试就用了主模型的词"）。
var REFUSAL_RE = /(抱歉|对不起|我无法|我不能|我无法协助|无法协助|不便协助|恕难|无法生成|不能生成|违反.{0,6}政策|不当内容|敏感内容|不符合.{0,6}(准则|规范)|作为.{0,4}(AI|人工智能|语言模型)|I can't|I cannot|I'm sorry|I am unable|As an AI|cannot assist|cannot help)/i;

export function classifyPipelineFailure(out, expectCount, meta, mode = getActiveMode(), canvas = getMossCanvas()) {
    // 截断**先判**。
    // 旧实现没有 truncated 这一类，截断被压缩成 empty（正文空）或 short（条数不足）：
    //   empty → 「不带上次输出整轮重发」→ 思考白烧一遍，还要再烧一遍；
    //   short → 「带上次输出补齐」→ 其实是对的，但那是偶然撞上的，不是设计。
    // 现在 finish_reason 从 auxApiCallRaw 一路传进来，截断有独立出口，交给帧内续写。
    if (meta && meta.truncated) return 'truncated';
    if (!out || !String(out).trim()) return 'empty';
    var t = String(out);
    var hasPro = /---\s*PROFILE\s*---/.test(t);
    var hasImg = /---\s*IMAGES\s*---/.test(t);
    if (!hasPro && !hasImg) return REFUSAL_RE.test(t.slice(0, 200)) ? 'refusal' : 'format';
    // ---PROFILE--- 是**必做段**（锚点/档案全靠它）。原来只有 IMAGES 也算合格 →
    // 实测出现过「图出了、3 个人一个锚点都没建」，而管线判定合格，谁也不会发现。
    if (!hasPro) return 'noprofile';
    // 结构标记在 → 再看 IMAGES 段实际回了几条
    if (expectCount && expectCount > 0) {
        var lines = [];
        try { lines = parseRosterImages(t, expectCount, mode) || []; } catch (ePL) { lines = []; }
        if (!lines.length) return REFUSAL_RE.test(t) ? 'refusal' : 'noimage';
        if (lines.length < expectCount) {
            // 条数不足时把"标记计数"打出来 —— 不猜，让失败可见。
            // IMAGES 出现多次 = 模型按"每个占位符各写一份三段"输出（解析器已合并，走到这里说明合并后仍不够）。
            var st = _markerStats(t);
            slErr('⚠️ 条数不足: 解析到 ' + lines.length + '/' + expectCount
                + ' | 标记 PROFILE=' + st.profile + ' IMAGES=' + st.images + ' CHECK=' + st.check + ' END=' + st.end
                + ' | 长度 ' + st.len
                + (st.images > 1 ? '  ← 多段输出，已由解析器合并' : ''));
            return 'short';
        }
        for (var i = 0; i < lines.length; i++) {
            if (lines[i] && lines[i].length < 120 && REFUSAL_RE.test(lines[i])) return 'refusal';
            if (isMossImageMode(mode) && !parseMossLayout(lines[i], canvas)) return 'layoutformat';
        }
    }
    return '';
}

// 把「缺第几条」说清楚，便于让模型补齐（而不是整轮重写）
function _missingHint(expectCount, gotCount) {
    var miss = [];
    for (var i = gotCount; i < expectCount; i++) miss.push('第' + (i + 1) + '条');
    return miss.length ? ('还缺 ' + miss.join('、') + '（共需 ' + expectCount + ' 条）') : ('共需 ' + expectCount + ' 条');
}

// ── 数字保真：逐条对比"主模型给的数字"与"输出提示词里剩下的数字" ──
// 返回 [{ i: 0, items: ['14岁'] }]（i = 占位符下标，0-based）
export function findLostNumbersInPrompts(placeholders, prompts, mode = getActiveMode()) {
    var misses = [];
    if (!placeholders || !prompts) return misses;
    var n = Math.min(placeholders.length, prompts.length);
    for (var i = 0; i < n; i++) {
        var ph = placeholders[i] || {};
        var segs = ph.personSegments || [];
        var src = [ph.scene || '', ph.topic || ''];
        for (var j = 0; j < segs.length; j++) src.push(segs[j].appearance || '');
        let text = prompts[i] || '';
        if (isMossImageMode(mode)) {
            const layout = parseMossLayout(text);
            text = layout ? [layout.summary.caption, ...layout.items.flatMap(item => [item.caption, ...(item.tags || [])])].join(' ') : '';
        }
        var lost = findLostNumbers(src.join(' '), text);
        if (lost.length) misses.push({ i: i, items: lost });
    }
    return misses;
}


// ── 地点保真：主模型给了地点，提示词里却找不到它的痕迹 → 只报警，不重试 ──
// 判据很粗：地点串的 2-gram 至少命中 1 个（地点通常短而具体，如「东北农村土炕」）
export function findLostPlaces(placeholders, prompts) {
    var out = [];
    if (!placeholders || !prompts) return out;
    var n = Math.min(placeholders.length, prompts.length);
    for (var i = 0; i < n; i++) {
        var ph = placeholders[i] || {};
        var place = String(ph.place || '').trim();
        if (!place) continue;
        var txt = String(prompts[i] || '');
        var hit = false;
        for (var k = 0; k + 2 <= place.length && !hit; k++) {
            if (txt.indexOf(place.slice(k, k + 2)) >= 0) hit = true;
        }
        if (!hit) out.push({ i: i, place: place });
    }
    return out;
}

// ── 事实通道（无词表）：`事实:` 段原样拼进提示词，校验用归一化逐字包含 ──
// facts.js 不再参与管线判断（事实由指令约束、日志审计）

// 它把 7 份文件 join 成一条 87.5 KB 字符串，正是下方要拆掉的东西。
// 保留一份平行实现 = 第二个权威来源 = 迟早漂。system 只由 buildPurgeMessages 产生。

// ══════════════════════════════════════════════════════════════
// 分层 system（位置层）
// ══════════════════════════════════════════════════════════════
// 旧实现把 7 份文件 join 成一条 ≈87.5 KB 的字符串（zit 模式实测约 2.8 万 token），
// <thinking_rules> 落在 roster/system.txt 第 46 行 ≈ 全文 7%。
// 而这条纪律在思考模式下承担的职责是"占住 CoT 的注意位"——7% 的位置承担不了。
//
// 现按「身份 → 纪律 → 规则 → 语料 → 模式」切成多条 system：
// 越靠前权重越高；查表用的词表压到最后。
// 位置就是权重：同一条 system 里，「你是 SIL」和「身高有哪些档位词」是同一量级。

// 把 core 按 <thinking_rules> 切成「前段 / 纪律 / 后段」，**只抽出 thinking_rules**。
// 其余一律保持原顺序 —— 尤其是 <behavior_prerecord>：
// 它的原文是「我会严格遵守以上全部规则」，必须留在 prohibitions/workflow 之后；
// 把它提到规则前面，等于让它确认一份还没读到的规则，后面的建档规范会被当成"补充资料"。
function splitDiscipline(core) {
    var src = String(core || '');
    var m = src.match(/<thinking_rules>[\s\S]*?<\/thinking_rules>/);
    if (!m) return { before: src.trim(), discipline: '', after: '' };
    var mark = '\u0000TR\u0000';
    var rest = src.replace(m[0], mark);
    var i = rest.indexOf(mark);
    return {
        before: rest.slice(0, i).trim(),
        discipline: m[0],
        after: rest.slice(i + mark.length).trim(),
    };
}

function _p(f) { return isPromptsLoaded() ? (getPrompt(f) || '') : ''; }

// ── 模式 → overlay 文件（单一来源）──
// 原先用嵌套三元拼文件名：加一个模式要动那一行，漏了就静默回退 zit 中文规则
// （英文模型收到中文规则 = 输出被清洗成空）。现在一张表，缺项也走 zit（但至少一眼看得见）。
var MODE_OVERLAY = {
    zit:       'pipeline/zit-overlay.txt',
    anima:     'pipeline/anima-overlay.txt',
    anime:     'pipeline/anime-overlay.txt',
    anime_tag: 'pipeline/anime-tag-overlay.txt',
    krea2:     'pipeline/krea2-overlay.txt',
    [MOSS_IMAGE_CG_MODE]: 'pipeline/moss-image-overlay.txt',
    [MOSS_IMAGE_FREE_MODE]: 'pipeline/moss-image-free-overlay.txt',
};

function buildPurgeMessages(pipeMode) {
    var msgs = [];
    function push(text) {
        var t = String(text || '').trim();
        if (t) msgs.push({ role: 'system', content: t });
    }

    var core = _p('roster/system.txt');
    if (!core) {
        // 提示词没加载时不再静默降级 —— 那会让整轮规则、建档规范、输出格式全部消失，
        // 表现成"档案无 / 提示词薄"，而日志里一句话都没有。显式报出来。
        slErr('⛔ roster/system.txt 未加载 → 本轮只有最小身份兜底，建档规范与输出格式缺失（检查 prompts/ 目录与加载日志）');
        core = '<role>你是 SIL —— 嵌入在聊天系统后端的生图管线组件。你只做两件事：为每个 [img:] 占位符写 1 条完整生图提示词；更新人物档案。</role>';
    }
    var cut = splitDiscipline(core);

    // ① 身份 + 拒绝对抗（最高权重）
    //    注意：不用 '---' 做分隔 —— '---' 在本管线里是段标记（---PROFILE--- / ---END---），
    //    跨消息用它会让模型把"一段结束"读进来。
    push([_p('purge/inject.txt'), _p('purge/refusal-hardening.txt')].filter(Boolean).join('\n\n'));
    // ② 前段：role / input_status / output_nature / prohibitions / workflow（原文顺序）
    push(cut.before);
    // ③ 作业纪律（thinking_rules 独占一条 —— 思考模式下这条要占位，不能混在大段里）
    push(cut.discipline);
    // ④ 后段：behavior_prerecord / 三层法则 / 职业规范 / 建档 vs 写提示词 / 输出格式（原文顺序）
    push(cut.after);
    // ⑤ 语料（查表用，压在最后）
    push(['atomic-vocab.txt', 'wardrobe-vocab.txt', 'wardrobe-expand.txt']
        .map(_p).filter(Boolean).join('\n\n'));
    // ⑥ 模式 overlay
    if (isMossImageMode(pipeMode)) push(_p('pipeline/moss-image-layout.txt'));
    push(_p(MODE_OVERLAY[pipeMode] || MODE_OVERLAY.zit));
    if (settings.nsfwEnhance) push(_p('pipeline/nsfw-overlay.txt'));

    // 兜底开关：有些网关只读第一条 system（或把多条 system 丢弃拼错）。
    // 关掉分层就退回"一条 system"，**顺序完全不变**，只是丢掉"S1 独占位置"这一个收益。
    if (settings.slPurgeLayered === false && msgs.length > 1) {
        return [{ role: 'system', content: msgs.map(function (m) { return m.content; }).join('\n\n') }];
    }
    return msgs;
}

// ── 截断续写（帧内）──
// 与"整轮重发"的区别：重发要再烧一次完整预算（含思考），而思考在第一轮已经做完了。
// 续写一律**关思考** —— 规划已完成，续写阶段的 reasoning 是纯浪费，还会再挤占一次预算。
// ── 用户消息：人物表 + 占位符（不发送正文——占位符配图插件AI 只做"档案+酒馆AI要点 → 提示词"的编辑） ──
function buildRosterUserContent(placeholders, wardrobeInfo, mode, canvas) {
    var lines = [];
    const moss = isMossImageMode(mode);
    lines.push('【任务】只处理本请求的一个占位符。按当前模式写出本图的入镜人物、造型、动作、场景和光影。');
    if (moss) lines.push('【布局画布】实际宽 ' + canvas.width + ' px，高 ' + canvas.height + ' px。以画布中心为原点，x 范围 ±' +
        canvas.width / 2 + '、y 范围 ±' + canvas.height / 2 + '；bbox 顺序 [y_min,x_min,y_max,x_max]。');
    // Krea 2 风格锁定 —— 风格句由插件统一前置（跨轮稳定），这里告诉模型"别再自己写媒介"
    if (mode === 'krea2') {
        var _kstyle = krea2StyleById(settings.krea2Style);
        if (_kstyle && _kstyle.prompt) {
            lines.push('【风格·已由插件锁定】' + _kstyle.prompt);
            lines.push('· 插件会在生图前拼接此预设。按 Krea 2 锁定画风时的写法交稿。');
        } else {
            lines.push('【风格】未锁定：依本图要点写媒介与质感。');
        }
    }
    lines.push('【输出格式】按系统的「输出格式」交稿。IMAGES 只写' +
        (moss ? '一个 MOSS-Image Layout JSON 对象。描述一律使用英文，画面原字按布局协议写入 text。' : '本图的一条文本提示词。'));
    lines.push('');
    lines.push('【人物档案】（按本轮占位符注明的人物名字过滤，插件自动匹配——同名不同身份全部给出，由你按场景选用；写提示词必须引用外貌锚点，禁止只写名字）');
    var _phNames = [];
    for (var nI = 0; nI < placeholders.length; nI++) { for (var nJ = 0; nJ < placeholders[nI].personSegments.length; nJ++) { _phNames.push(placeholders[nI].personSegments[nJ].name); } }
    var rosterTxt = rosterDataTextFor(_phNames, placeholders[0]?.seed);
    lines.push(rosterTxt || '（占位符未注明人物名或人物未建档；画师直接按【占位符】场景/要点描述画面，并可用 PROFILE 为新人物建档）');
    lines.push('');
    // 【造型库】—— 服装/发型/鞋袜/配饰/妆容。已解析的原样复用（零漂移），未命中的具象化后回传
    if (wardrobeInfo && wardrobeInfo.text) {
        lines.push('【造型库】');
        lines.push(wardrobeInfo.text);
        lines.push('');
    }

    lines.push('【占位符】');
    if (placeholders.length) {
        for (var i = 0; i < placeholders.length; i++) {
            var ph = placeholders[i];
            lines.push((i + 1) + '. 场景：' + ph.scene);
            // 地点是**硬约束** —— 插件不给世界观，地点只能靠主模型这段字
            if (ph.place) lines.push('   地点：' + ph.place);
            if (ph.personSegments && ph.personSegments.length) {
                var ps = [];
                for (var j = 0; j < ph.personSegments.length; j++) ps.push(ph.personSegments[j].name + (ph.personSegments[j].identity ? '（' + ph.personSegments[j].identity + '）' : ''));
                lines.push('   人物：' + ps.join('、'));
            }
            if (ph.seed) lines.push('   【种子】（本图取词方向）：' + ph.seed);
            if (ph.topic) lines.push('   要点：' + ph.topic.replace(/\n/g, '；'));
            // 这一条占位符里的状态事实（怀孕/绷带/纹身…）→ 点名要求出现事实词
            if (ph.facts && ph.facts.length) lines.push('   事实：' + ph.facts.join('；'));
            // 场景和要点已随请求发送。只补人物段里另行提供的可变信息。
            for (const person of ph.personSegments || []) {
                const cues = extractDynamicBits(person.appearance)
                    .filter(cue => !ph.scene.includes(cue) && !ph.topic.includes(cue));
                if (cues.length) lines.push('   人物段补充（' + person.name + '）：' + cues.join('、'));
            }
        }
    }
    // [Fix] 占位符配图不发送【当前正文】：主模型已在占位符里写了画面要素（谁+动作+表情+可变衣着），
    // 根据人物档案和占位符要点编写该图的提示词。
    return lines.join('\n');
}

// ── 输出解析 ──
// ── 宽容 JSON：LLM 的 PROFILE 段经常不是合法 JSON ──
// 实测最常见的三种坏法：① 字符串里带**裸换行**（没转义）② 尾逗号 ③ ```json 围栏。
// 旧实现只处理了①的一种形态，一旦 JSON.parse 失败就**静默返回 null** →
// PROFILE 整段被丢掉 → 人物档案只建了主模型原文那层、**锚点永远空着**，而且没人发现。
function _looseJson(raw) {
    var t = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
    var i = t.indexOf('{'), j = t.lastIndexOf('}');
    if (i >= 0 && j > i) t = t.slice(i, j + 1);
    t = t.replace(/,\s*([}\]])/g, '$1');
    var out = '', inStr = false, esc = false;
    for (var k = 0; k < t.length; k++) {
        var ch = t[k];
        if (inStr) {
            if (esc) { out += ch; esc = false; continue; }
            if (ch === '\\') { out += ch; esc = true; continue; }
            if (ch === '"') { inStr = false; out += ch; continue; }
            if (ch === '\n') { out += '\\n'; continue; }
            if (ch === '\r') { continue; }
            if (ch === '\t') { out += '\\t'; continue; }
            out += ch;
            continue;
        }
        if (ch === '"') { inStr = true; out += ch; continue; }
        out += ch;
    }
    return JSON.parse(out);
}

// ══════════════════════════════════════════════════════════════
// 多段容错
// ══════════════════════════════════════════════════════════════
// 旧解析器用**单段**正则：`---NAME---([\s\S]*?)(?:---END---|$)`，只取第一个同名段。
// 而模型完全可能按「每个占位符走一遍 workflow」来输出 —— 那就有 N 个 PROFILE/IMAGES/END。
// 结果：3 个 IMAGES 段只解析出第 1 条 → classifyPipelineFailure 判 short → 整轮重试 → 白烧。
//
// 2026-10-25 实测：finish=stop / content=14707 字 / system 分层=6 / 判 short（需要 3 条）。
// 六种输出格式逐一验证，只有「每个占位符一份完整三段」会产生 short。
//
// 现在：收集**全部同名段**再合并。单段输入的行为与原来逐字一致（回归 T2 钉住）。
function _allSections(output, name) {
    var re = new RegExp(
        '---\\s*' + name + '\\s*---([\\s\\S]*?)'
        + '(?:---\\s*END\\s*---|(?=---\\s*(?:PROFILE|IMAGES|CHECK|WARDROBE)\\s*---)|$)',
        'g');
    var out = [], m, t = String(output || '');
    while ((m = re.exec(t)) !== null) {
        var seg = m[1].trim();
        if (seg) out.push(seg);
    }
    return out;
}

// 标记计数：失败时用来说明"到底是几个段"，不是猜
function _markerStats(out) {
    var t = String(out || '');
    var n = function (name) { return (t.match(new RegExp('---\\s*' + name + '\\s*---', 'g')) || []).length; };
    return { profile: n('PROFILE'), images: n('IMAGES'), check: n('CHECK'), end: n('END'), len: t.length };
}

// 同一人被多段重复建档：后段补充前段，不丢前段的非空字段
function _mergePersonEntry(a, b) {
    if (!a) return b;
    if (!b || typeof b !== 'object') return a;
    var out = {}, k;
    for (k in a) out[k] = a[k];
    for (k in b) {
        var v = b[k];
        if (v === null || v === undefined || v === '') continue;
        var isObj = v && typeof v === 'object' && !Array.isArray(v);
        var oldObj = out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]);
        if (isObj && oldObj) {
            var sub = {}, sk;
            for (sk in out[k]) sub[sk] = out[k][sk];
            for (sk in v) if (v[sk]) sub[sk] = v[sk];
            out[k] = sub;
        } else {
            out[k] = v;
        }
    }
    return out;
}

// WARDROBE 这种 key→string 的段：宽容 JSON → 对象
function _looseKeyMap(text, tag) {
    try {
        var fixed = (String(text || '').trim()).replace(/:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g,
            function (match) { return match.replace(/\n/g, '\\n').replace(/\r/g, ''); });
        var i = fixed.indexOf('{'), j = fixed.lastIndexOf('}');
        if (i >= 0 && j > i) return JSON.parse(fixed.substring(i, j + 1));
    } catch (e) { slLog(tag + ' JSON解析失败: ' + e.message); }
    return null;
}

export function parseRosterProfile(output) {
    var sections = _allSections(output, 'PROFILE');
    if (!sections.length) { slErr('⛔ 模型没输出 ---PROFILE--- 段（本轮锚点/档案不会更新）'); return null; }
    var merged = null;
    for (var s = 0; s < sections.length; s++) {
        var obj = null;
        try { obj = _looseJson(sections[s]); }
        catch (e) {
            slErr('⛔ PROFILE JSON 解析失败(段 ' + (s + 1) + '/' + sections.length + '): ' + e.message
                + ' | 原文前 200 字: ' + sections[s].slice(0, 200).replace(/\s+/g, ' '));
            continue;
        }
        if (!obj || typeof obj !== 'object') continue;
        var persons = obj.persons;
        if (!persons || typeof persons !== 'object') continue;
        if (!merged) merged = { persons: {} };
        for (var k in persons) merged.persons[k] = _mergePersonEntry(merged.persons[k], persons[k]);
    }
    if (!merged) return null;
    if (sections.length > 1) {
        slLog('parseRosterProfile: 合并 ' + sections.length + ' 个 PROFILE 段 → ' + Object.keys(merged.persons).length + ' 人');
    }
    return merged;
}

// 解析可选的 ---WARDROBE--- 段（key → detail）
export function parseRosterWardrobe(output) {
    var sections = _allSections(output, 'WARDROBE');
    if (!sections.length) return null;
    var merged = {};
    for (var s = 0; s < sections.length; s++) {
        var obj = _looseKeyMap(sections[s], '造型 WARDROBE');
        if (obj) for (var k in obj) merged[k] = obj[k];
    }
    return Object.keys(merged).length ? merged : null;
}

// 单段内的行解析（原逻辑，逐字搬出以免行为漂移）
function _parseImageLines(text) {
    var t = String(text || '').trim();
    if (!t || t === '（无）' || t === '(无)') return [];
    var lines = t.split(/\n/);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        // 列表标记（1. / - / • 等）= 新提示词；无标记短行(<15字)且已有上一条 = 上一条的续行（LLM 偶发跨行换行，防拆条错位）
        // [Fix] 续行规则加固（C7）：原实现把所有无标记短行(<15字)并入上一条，
        // 独立短条目（如"特写：油灯"）也被吞掉，导致与占位符按序配对整体错位。
        // 现在：形似新条目（含冒号/构图词）不合并；上一条已以句末标点结束不合并；
        // 其余（典型跨行换行碎片）仍合并。
        var _prevLine = out.length ? out[out.length - 1] : '';
        var _looksNewItem = /[:：]/.test(line) || /^(特写|近景|远景|中景|全景|构图|视角|镜头|画面)/.test(line);
        if (out.length && !/^(?:\d+[.、)]|[-•·])\s*/.test(line) && line.length < 15 && !/^【/.test(line)
            && !_looksNewItem && !/[。！？!?；;]$/.test(_prevLine)) {
            out[out.length - 1] += '\n' + line;
            continue;
        }
        line = line.replace(/^(?:\d+[.、)]|[-•·])\s*/, '').replace(/^【提示词[】:：]*\s*/, '');
        // [Fix] 容错：插件AI偶发输出完整图块（[image:…]【提示词】…【/提示词】）而非纯提示词——
        // 剥掉图块包装取内部提示词，否则嵌套图块 → 多渲染一张卡 + 原始图块文本进生成提示词
        if (line.indexOf('[image:') >= 0 || line.indexOf('【／提示词】') >= 0 || line.indexOf('【/提示词】') >= 0) {
            var innerM = line.match(/【提示词[】:：]*([\s\S]*?)【\/提示词】/);
            if (innerM) {
                line = innerM[1].trim();
            } else {
                line = line.replace(/^\s*\[image:[^\]]*\]\s*/, '').replace(/【提示词[】:：]*/g, '').replace(/【\/提示词】/g, '').trim();
            }
        }
        // 连续去重：包装剥离后可能与后续行重复
        if (line) { var _lt = line.trim(); if (out.length === 0 || out[out.length - 1] !== _lt) out.push(_lt); }
    }
    return out;
}

export function parseRosterImages(output, expectedCount, mode = getActiveMode()) {
    if (isMossImageMode(mode)) {
        // Match section markers on their own lines so literal lettering inside JSON is preserved.
        const section = /(?:^|\n)[ \t]*---IMAGES---[ \t]*\r?\n([\s\S]*?)(?=\n[ \t]*---(?:END|PROFILE|IMAGES|CHECK|WARDROBE)---[ \t]*(?:\r?\n|$)|$)/.exec(output);
        const part = section?.[1].trim().replace(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i, '$1');
        return part && !/^(?:（无）|\(无\))$/.test(part) ? [part] : [];
    }
    var sections = _allSections(output, 'IMAGES');
    if (!sections.length) return [];
    if (expectedCount === 1) {
        const part = sections[0].trim();
        if (!part || /^(?:（无）|\(无\))$/.test(part)) return [];
        const wrapped = part.match(/【提示词[】:：]*([\s\S]*?)【\/提示词】/);
        return [(wrapped ? wrapped[1] : part).replace(/^\s*(?:\d+[.、)]|[-•·])\s*/, '').trim()];
    }
    if (sections.length === 1) return _parseImageLines(sections[0]);
    // 多段：逐段解析后按出现顺序拼接（跨段重复条目丢弃）
    var out = [];
    for (var s = 0; s < sections.length; s++) {
        var part = _parseImageLines(sections[s]);
        for (var k = 0; k < part.length; k++) {
            if (!out.length || out[out.length - 1] !== part[k]) out.push(part[k]);
        }
    }
    slLog('parseRosterImages: 输出含 ' + sections.length + ' 个 IMAGES 段（模型按每个占位符各写一份）→ 合并为 ' + out.length + ' 条');
    return out;
}

// ── 占位符替换：原文 [img:…] → [image:场景]【提示词】…【/提示词】 ──
export function fillPlaceholders(bodyText, placeholders, prompts, mode = getActiveMode()) {
    var phIdx = 0, pIdx = 0, missing = 0;
    var values = placeholders.map(function(ph) {
        var m = ph.text;
        var ph = placeholders[phIdx];
        phIdx++;
        if (!ph) return m;                    // 意外错位：保留原文
        var prompt = '';
        if (pIdx < prompts.length) { prompt = prompts[pIdx]; pIdx++; }
        if (!prompt) {
            // 代码不编造内容 —— 缺条就保留占位符原文，交给重试/人工
            missing++;
            slErr('⛔ 第' + phIdx + '个占位符没有提示词（模型漏回）→ 保留 [img:] 原文，不补写');
            return m;
        }
        // 事实审计只检查字面命中；等义表达不会因此被拦截。
        try { _auditFacts(ph, prompt, phIdx); } catch (eAudit) {}
        // 英文模式：字面出现的事实原样保护，避免被中文清洗吃掉（机械替换，不做语义判断）
        try {
            if (isEnglishMode(mode) && !isMossImageMode(mode)) {
                var _fs2 = ph.facts || [];
                for (var _fi = 0; _fi < _fs2.length; _fi++) {
                    var _f = String(_fs2[_fi] || '');
                    if (_f && prompt.indexOf(_f) >= 0) prompt = prompt.split(_f).join(wrapFactSpan(_f));
                }
            }
        } catch (eWrap) {}
        return buildImageBlock(ph.scene, prompt);
    });
    var out = replaceTokens(bodyText, placeholders, values);
    if (prompts.length !== placeholders.length) {
        slErr('⚠️ 提示词条数(' + prompts.length + ') ≠ 占位符数(' + placeholders.length + ')，按序配对');
    }
    slLog('占位符填充: ' + (phIdx - missing) + '/' + placeholders.length + '（缺 ' + missing + '，未做任何内容补写）');
    return out;
}

// 事实审计：只记录"给出的事实里，有几个在这条提示词里字面出现"
// 等义翻译也可能记为未逐字出现。
function _auditFacts(ph, prompt, idx) {
    var facts = (ph && ph.facts) || [];
    if (!facts.length) return;
    var hit = [], miss = [];
    for (var i = 0; i < facts.length; i++) {
        if (String(prompt || '').indexOf(facts[i]) >= 0) hit.push(facts[i]);
        else miss.push(facts[i]);
    }
    slLog('事实审计 #' + idx + ': 给出[' + facts.join('；') + '] 字面命中[' + (hit.join('；') || '无') + ']'
        + (miss.length ? ' 未逐字[' + miss.join('；') + ']（可能是合法同义，看图确认）' : ''));
}

async function requestImageOutput(config, retry, { placeholders, mode, canvas, sysMsgs, userContent, isCurrent, signal }) {
    const callApi = async messages => {
        signal?.throwIfAborted();
        if (!isCurrent()) throw new Error('回复版本已变更');
        const reply = await auxApiCallRaw(messages, null, 16384, 0.25, undefined, { signal, config });
        if (!isCurrent()) throw new Error('回复版本已变更');
        return reply;
    };
    var expectN = placeholders.length;
    var baseMsgs = sysMsgs.concat([{ role: 'user', content: userContent }]);

    var _res = await callApi(baseMsgs);
    slLog('首调: finish=' + _res.finish + ', content=' + _res.content.length + ' 字, reasoning=' + _res.reasoningLen + ' 字'
        + ', system 分层=' + sysMsgs.length + ' 条');

    var output = _res.content;
    var _meta = { finish: _res.finish, truncated: _res.truncated, reasoningLen: _res.reasoningLen };
    // 失败重试（兜底指令只在重试时下发 —— system prompt 里不留任何"可以省略/可以软化"的退路）
    //   拒绝/空回/格式崩 → **不带上次输出**重发（带着拒绝语重试会让它锚定在"我刚拒绝了"上）
    //   条数不足       → **带上上次输出** + 点名缺第几条（让它接着补，而不是整轮重写又漏）
    var _fail = classifyPipelineFailure(output, expectN, _meta, mode, canvas);
    // 数字保真闸门：条数对了，但主模型给的数字在提示词里蒸发了 → 同样算不合格
    var _lostNum = [];
    if (!_fail) {
        try { _lostNum = findLostNumbersInPrompts(placeholders, parseRosterImages(output, 1, mode), mode); } catch (eLN) { _lostNum = []; }
        if (_lostNum.length) {
            _fail = 'lostnum';
            slErr('⚠️ 数字保真：主模型给的数字在提示词里丢了 · ' + _lostNum.map(function (x) { return '第' + (x.i + 1) + '条 ' + x.items.join('、'); }).join(' / '));
        }
    }
    if (_fail) {
        if (!retry) throw new Error('本图首次回复不合格: ' + _fail);
        slErr('⚠️ 管线输出不合格(' + _fail + ', ' + (output ? output.length : 0) + ' 字, 需要 ' + expectN + ' 条) → 重试');
        var _gotN = 0;
        try { _gotN = (_fail === 'short' || _fail === 'truncated') ? (parseRosterImages(output, 1, mode) || []).length : 0; } catch (eG) { _gotN = 0; }
        var _need = _missingHint(expectN, _gotN);
        // **除了 refusal，其余一律带上上次输出**。
        // 理由：模型每次调用都是无状态的，任务素材（档案/种子/占位符）全在 userContent 里，
        // 所以"不带上次输出"它照样知道要干嘛 —— 但 short/format/noimage 这三种失败里，
        // 上次的内容往往是**有价值的**（short 的 1 条成品 / format 的散装提示词 / noimage 的（无）），
        // 丢掉等于白烧一次 token。只有 refusal 不能带（带着拒绝语重试会让它锚定在"我刚拒绝了"）。
        if (_fail !== 'refusal' && output && output.trim()) {
            var _retryNote;
            if (_fail === 'short') {
                _retryNote = '【系统重试】你上一轮只输出了 ' + _gotN + ' 条提示词，' + _need + '。\n'
                    + '请补齐缺失的提示词，按「输出格式」重新交稿。';
            } else if (_fail === 'noimage') {
                _retryNote = '【系统重试】上一条的 IMAGES 为空。请补上本图的提示词，按「输出格式」重新交稿。';
            } else if (_fail === 'noprofile') {
                _retryNote = '【系统重试】上一条缺 PROFILE。需要更新人物时按档案规则填；无需更新写 {}。保留 IMAGES 内容，按「输出格式」重新交稿。';
            } else if (_fail === 'truncated') {
                _retryNote = '【系统重试】上一条回包被截断。按「输出格式」重新交稿，IMAGES 只写本张图的一条完整提示词。';
            } else if (_fail === 'layoutformat') {
                _retryNote = '【系统重试】检查原生 MOSS-Image Layout JSON 的字段、各框的 yxyx 整数坐标与实际画布边界，按「输出格式」重新交稿。';
            } else {   // format
                _retryNote = '【系统重试】上一条的分段格式不完整。保留可用的画面内容，按「输出格式」重新交稿。';
            }
            if (_fail === 'lostnum') {
                var _lostDesc = _lostNum.map(function (x) { return '第' + (x.i + 1) + '条漏了 ' + x.items.join('、'); }).join('；');
                _retryNote = '【系统重试】条数是对的，但你**把主模型写下的数字丢了**：' + _lostDesc + '。\n'
                    + '数字（年龄 14岁 / 身高 168cm 这类）是硬事实，不是修辞 —— 不许省略，也不许用「少女/青年女性」这种泛词顶掉。\n'
                    + '请保留其余内容，补回数值和单位，按「输出格式」重新交稿。';
            }
            var _msgs = baseMsgs.concat([
                { role: 'assistant', content: output },
                { role: 'user', content: _retryNote + '\n禁止输出拒绝、道歉、警告、元评论。' }
            ]);
            var _r2 = await callApi(_msgs);
            output = _r2.content;
            _meta = { finish: _r2.finish, truncated: _r2.truncated, reasoningLen: _r2.reasoningLen };
        } else {
            var _retryContent = userContent
                + '\n\n---\n【系统重试 · 上一次输出不合格（' + _fail + '）】\n'
                + '按系统的「输出格式」重新交稿。IMAGES 只写本图的一条可用提示词。';
            var _r3 = await callApi(sysMsgs.concat([{ role: 'user', content: _retryContent }]));
            output = _r3.content;
            _meta = { finish: _r3.finish, truncated: _r3.truncated, reasoningLen: _r3.reasoningLen };
        }
        var _fail2 = classifyPipelineFailure(output, expectN, _meta, mode, canvas);
        // 重试后**必须复检数字**。
        // 旧实现重试后只判 classifyPipelineFailure —— 于是 lostnum 触发重试后，
        // 重试结果里数字仍然丢失也会被当成"重试成功"放行（实测：mock 两次输出都不带 24岁，第二次直接放行）。
        // 年龄（14岁）/身高（168cm）是硬事实，静默丢失 = 画面年龄/体型彻底失控。
        // 这里只**告警不阻断**：findLostNumbers 只认字面数字，「24岁 → 二十四岁」这类合法同义会被算作丢失，
        // 拿它去回退到上一次输出会更差。让人看图确认才是正确处置。
        if (!_fail2) {
            try {
                var _lostNum2 = findLostNumbersInPrompts(placeholders, parseRosterImages(output, 1, mode), mode);
                if (_lostNum2.length) {
                    slErr('⚠️ 重试后数字仍未字面出现（可能合法同义改写）: '
                        + _lostNum2.map(function (x) { return '第' + (x.i + 1) + '条 ' + x.items.join('、'); }).join(' / ')
                        + ' → 不阻断，按现状继续；数字直接决定画面年龄/体型，请人工看图确认');
                }
            } catch (eLN2) { /* 复检失败不影响主流程 */ }
        }
        if (_fail2) {
            throw new Error('本图提示词仍不合格: ' + _fail2);
        } else {
            slLog('重试成功: ' + output.length + ' 字, ' + (parseRosterImages(output, 1, mode) || []).length + ' 条');
        }
    }
    if (!output || !output.trim()) throw new Error('插件AI返回空');
    return output;
}

// ── 入口 ──
async function runSinglePipeline(bodyText, mesId, options) {
    const mode = getActiveMode(), canvas = getMossCanvas();
    var placeholders = findImagePlaceholders(bodyText);
    if (!placeholders.length) {
        slLog('协作管线: 无 [img:] 占位符，本轮无图（正常完成）');
        return { ok: true, enhanced: null, noPlaceholder: true };
    }
    slLog('协作管线启动: ' + placeholders.length + ' 个占位符');
    try {
        // 1. 占位符人物段直接建档（无LLM）——先做"已知人名拆段"（人物:柳如烟，赵云飞 逗号多人 → 拆两人）
        var _known = [];
        try {
            var _re = rosterEntries();
            for (var _ri = 0; _ri < _re.length; _ri++) _known.push(String(_re[_ri].name || '').replace(/（[^）]*）$/, ''));
        } catch (e4) {}
        placeholders = placeholders.map(function(p) {
            if (p.personSegments && p.personSegments.length) {
                p.personSegments = splitKnownPersonSegments(p.personSegments, _known);
            }
            return p;
        });
        var nApplied = applyPersonSegments(placeholders.map(function(p) { return p.personSegments; }).reduce(function(a, b) { return a.concat(b); }, []));
        if (nApplied) { void saveArchive(); slLog('占位符建档: ' + nApplied + ' 人'); }

        // 1.5 造型库：解析造型段 → 查库
        // 已解析的 detail 与待具象化的 key 随单图请求发送。
        var _allStyleGroups = [];
        for (var _pi = 0; _pi < placeholders.length; _pi++) {
            var _sg = placeholders[_pi].styleGroups || [];
            for (var _sj = 0; _sj < _sg.length; _sj++) _allStyleGroups.push(_sg[_sj]);
        }
        var wardrobeInfo = { text: '', resolved: [], pending: [] };
        if (_allStyleGroups.length) {
            wardrobeInfo = wardrobeDataTextFor(_allStyleGroups);
            slLog('造型库: 已解析 ' + wardrobeInfo.resolved.length + ' 条 / 待具象化 ' + wardrobeInfo.pending.length + ' 条');
        }

        // 2. 调用插件AI
        var sysMsgs = buildPurgeMessages(mode);
        var userContent = buildRosterUserContent(placeholders, wardrobeInfo, mode, canvas);
        const output = await withAuxiliaryFallback((config, retry) =>
            requestImageOutput(config, retry, { placeholders, mode, canvas, sysMsgs, userContent, ...options }), options);
        // [Fix] 打印原始输出（首尾各200字）：提示词解析失败时凭日志定位 AI 的实际输出格式
        slLog('协作管线LLM返回, 长度=' + output.length + ' 前200: ' + output.slice(0, 200).replace(/\n/g, '⏎'));
        slLog('协作管线LLM返回, 尾200: ' + output.slice(-200).replace(/\n/g, '⏎'));

        if (!options.isCurrent()) return { ok: false, stale: true };
        // 3.0 自校记录（---CHECK---）：模型自己写的校对结果，只记录、不判分、不进生图
        try {
            var _check = parseCheckSection(output);
            if (_check.length) {
                for (var _ci = 0; _ci < _check.length; _ci++) slLog('自校 #' + (_ci + 1) + ': ' + _check[_ci]);
                var _bad = [];
                for (var _bj = 0; _bj < _check.length; _bj++) {
                    // 只盯"事实=无"这一类自报缺失；"角色名=无" 是好事，不能误报
                    if (/事实\s*[:：]\s*无|事实\s*[:：][^｜|]*?=\s*无/.test(_check[_bj])) _bad.push(_check[_bj]);
                }
                if (_bad.length) slLog('自检记录含「事实=无」，请结合本图事实和景别查看：' + _bad.join(' / '));
            } else {
                slLog('本图未回传可选的 ---CHECK--- 记录');
            }
        } catch (eCK) { slLog('自校段解析跳过: ' + eCK.message); }

        // 3. 解析 PROFILE（人物表更新）
        var profileData = parseRosterProfile(output);
        if (profileData && profileData.persons) {
            var ups = 0, nAnchors = 0, nZh = 0, nRej = 0, nPort = 0;
            for (var k in profileData.persons) {
                var pe = profileData.persons[k];
                var upName = (pe && pe.name) || k.replace(/（[^）]*）$/, '');
                var upIdm = (pe && pe.identity) || (k.indexOf('（') >= 0 ? k.slice(k.indexOf('（') + 1, k.lastIndexOf('）')) : '');
                if (pe && pe.appearance) { upsertPerson(upName, upIdm, pe.appearance, 'profile'); ups++; }
                // 锚点库：anchor = **英文权威锚点**（四种模式共用，逐字复用 → 零漂移）
                //            anchor_zh = 中文呈现缓存（只给 zit 中文模式用）
                // 闸门在 roster.js：英文进 anchor；中文只允许在 zit 模式进缓存；其余拒绝并记日志
                if (pe && pe.anchor) {
                    if (setEnglishAnchor(upName, upIdm, pe.anchor)) nAnchors++;
                    else if (String(getActiveMode()) === 'zit') {
                        // [Fix] zit 模式下辅助AI 习惯把**中文锚点塞进 anchor 字段** →
                        // 旧实现被英文闸门直接拒掉，而 anchor_zh 又没给 → anchor 和 atoms.zit **两边都空**
                        // （实测：萝莉岛 13:30 / 13:53 两个聊天的人物档案就是"有 base 无锚点"，锚点永远填不上）。
                        // 现在：zit 模式下把中文锚点收进中文呈现缓存，别白扔。
                        if (setZitAnchor(upName, upIdm, pe.anchor)) { nZh++; slLog('锚点回退为中文呈现缓存（anchor 字段给了中文）: ' + upName); }
                        else nRej++;
                    } else nRej++;
                }
                if (pe && pe.anchor_zh) { if (setZitAnchor(upName, upIdm, pe.anchor_zh)) nZh++; }
                // 立绘提示词：建档时一并产出（四视角），之后"生成立绘"直接用，不再由插件拼装
                if (pe && (pe.portrait || pe.portraits)) {
                    if (setPortraitPrompts(upName, upIdm, pe.portrait || pe.portraits)) nPort++;
                }
            }
            if (ups) slLog('协作PROFILE档案更新: ' + ups + ' 人');
            if (nAnchors) slLog('英文锚点更新: ' + nAnchors + ' 条');
            if (nZh) slLog('中文呈现锚点更新: ' + nZh + ' 条');
            if (nPort) slLog('立绘提示词更新: ' + nPort + ' 人（正面/左/右/背）');
            if (nRej) slErr('⛔ PROFILE.anchor 被拒（含中文，英文槽位只收英文）: ' + nRej + ' 条 —— 详见上方锚点日志');
        }


        // PROFILE 没覆盖到的人 → 明确报警（否则锚点永远空着，没人发现）
        try {
            var _ents = rosterEntries();
            var _seenName = {};
            var _noAnchor = [];
            for (var _pi = 0; _pi < placeholders.length; _pi++) {
                var _pl = placeholders[_pi] || {};
                var _segs = _pl.personSegments || [];
                for (var _sj = 0; _sj < _segs.length; _sj++) {
                    var _nm2 = _segs[_sj].name;
                    if (!_nm2 || _seenName[_nm2]) continue;
                    _seenName[_nm2] = 1;
                    var _hit = null;
                    for (var _ei = 0; _ei < _ents.length; _ei++) {
                        var _ek = String(_ents[_ei].key || '');
                        if (_ek === _nm2 || _ek.indexOf(_nm2 + '（') === 0 || _ents[_ei].name === _nm2) { _hit = _ents[_ei]; break; }
                    }
                    if (!_hit) continue;
                    var _hasAtom = false;
                    try { _hasAtom = !!getAtomAnchor(_hit, getActiveMode()); } catch (eAT) { _hasAtom = false; }
                    if (!_hasAtom) _noAnchor.push(_ek);
                }
            }
            if (_noAnchor.length) slErr('⛔ 本轮结束仍没有锚点（下轮起每张图都会重新编脸）: ' + _noAnchor.join('、'));
        } catch (eMA) { slLog('锚点体检跳过: ' + eMA.message); }
        // 3.5 解析 ---WARDROBE--- → 回写造型库（下次即可原样复用，零漂移）
        var wdData = parseRosterWardrobe(output);
        if (wdData && wardrobeInfo.pending.length) {
            var _slotByKey = {};
            for (var _pk = 0; _pk < wardrobeInfo.pending.length; _pk++) _slotByKey[wardrobeInfo.pending[_pk].key] = wardrobeInfo.pending[_pk].slot;
            var wUps = 0;
            for (var _wk in wdData) {
                var _det = wdData[_wk];
                if (typeof _det !== 'string' || !_det.trim()) continue;
                var _slot = _slotByKey[_wk];
                if (!_slot) {   // 容错：AI 改了大小写/标点时按归一化匹配
                    var _nw = normKey(_wk);
                    for (var _pk2 in _slotByKey) { if (normKey(_pk2) === _nw) { _slot = _slotByKey[_pk2]; break; } }
                }
                if (!_slot) { slLog('造型回写跳过（槽位未知）: ' + _wk); continue; }
                upsertEntry(_slot, _wk, _det.trim(), 'expanded');
                wUps++;
            }
            if (wUps) slLog('造型库回写: ' + wUps + ' 条');
        }
        void saveArchive();

        // 4. 解析提示词并填充
        var prompts = parseRosterImages(output, 1, mode);
        if (isMossImageMode(mode)) prompts = prompts.map(prompt => JSON.stringify(JSON.parse(prompt)));
        // 地点保真：不阻断、不重试，只点名（场景对不上就是这里漏的）
        try {
            var _lostPlace = findLostPlaces(placeholders, prompts);
            for (var _lp = 0; _lp < _lostPlace.length; _lp++) {
                slErr('⚠️ 地点丢失：第' + (_lostPlace[_lp].i + 1) + '条提示词里找不到「' + _lostPlace[_lp].place + '」的痕迹（场景/背景可能被写成通用室内）');
            }
        } catch (eLP) { slLog('地点体检跳过: ' + eLP.message); }
        var enhanced = fillPlaceholders(bodyText, placeholders, prompts, mode);
        return { ok: true, enhanced: enhanced };
    } catch (e) {
        slErr('协作管线失败: ' + e.message);
        return null;
    }
}

// A distinct request and result slot for EVERY occurrence (including identical
// markers). A model omission can never shift later prompts into the wrong image.
export async function runRosterPipeline(bodyText, mesId, options = {}) {
    const isCurrent = options.isCurrent || (() => true);
    const retryable = !settings.auxUseStrategy;
    const tokens = tokenizePlaceholders(bodyText);
    const values = [];
    const results = options.results || new Map();
    let succeeded = 0;
    for (const token of tokens) {
        if (!isCurrent()) return { ok: false, stale: true };
        const result = results.get(token.index) || await runSinglePipeline(token.text, mesId + '#' + token.index, { isCurrent, signal: options.signal });
        if (!isCurrent()) return { ok: false, stale: true };
        if (result?.enhanced && result.enhanced !== token.text) {
            results.set(token.index, result);
            values[token.index] = result.enhanced;
            options.onSlot?.(token.index, result.enhanced);
            succeeded++;
        }
    }
    return { ok: succeeded === tokens.length, enhanced: replaceTokens(bodyText, tokens, values),
        tokens, partial: succeeded > 0 && succeeded < tokens.length, retryable };
}
