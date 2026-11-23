import { clampPosition } from './viewport.js';
// ── SillyImage Lab 紧凑状态条（胶囊猫条） ──
import { CAT, getCatStatusFace } from './theme.js';
import { rosterEntries } from '../roster.js';
import { catSVG, catStatusText } from './cat.js';
import { setHeadStatus } from './panel.js';
import { toast, chkProf } from './utils.js';
import { settings, saveSettings, getActiveMode, modeBadge } from '../settings.js';
import { getCharacterName } from '../archive.js';
import { getScannerStatus, cancelPendingScans, queueMessageFloors, resetAutomaticBacklog } from '../scanner.js';
import { resetFrontendAutomaticBacklog } from '../frontend-bridge.js';
import { getQueueLength, clearQueue } from '../queue.js';
import * as panel from './panel.js';  // 循环依赖：仅函数体内引用，运行时安全

var _compactCleanup = null;
var _compactEl = null, _compactTimer = null, _compDragMoved = false;
const compactPositionKey = 'sl_compact_pos';
const snapDistance = 24;

export function getCompactEl() { return _compactEl; }

export function setPluginEnabled(enabled) {
    if (enabled) {
        if (_compactEl) _compactEl.show();
        if (!_compactTimer) { _compactTimer = setInterval(refreshCompactBar, 3000); }
    } else {
        if (_compactEl) _compactEl.hide();
        if (_compactTimer) { clearInterval(_compactTimer); _compactTimer = null; }
    }
}

export function rebuildCompactBar() {
    if (_compactCleanup) { _compactCleanup(); _compactCleanup = null; }
    if (_compactEl) { clearInterval(_compactTimer); _compactEl.remove(); _compactEl = null; _compactTimer = null; }
    createCompactBar();
}
export function createCompactBar() {
  if (_compactEl && _compactEl.parent().length) return;
  var bar = '';
  bar += '<div id="sl_compact" style="position:fixed;z-index:30000;background:' + CAT.card + ';border-radius:' + CAT.radius + ';box-shadow:0 14px 44px rgba(150,100,60,0.22);border:' + CAT.borderStyle + ' ' + CAT.line + ';font-family:' + CAT.font + ';font-size:12px;color:' + CAT.text + ';user-select:none;overflow:hidden;display:flex;flex-direction:column;">';
  // 头部：猫脸泡泡 + 文案 + 日志爪印
  bar += '<div id="sl_comp_header" style="display:flex;align-items:center;gap:9px;padding:10px 12px 8px;cursor:move;touch-action:none;border-bottom:1px solid ' + CAT.line + ';flex-shrink:0;height:22%;background:linear-gradient(135deg,' + CAT.accent + '14,transparent);">';
  bar += '<span id="sl_cat_icon" style="width:34px;height:34px;border-radius:12px;background:' + CAT.bg + ';display:flex;align-items:center;justify-content:center;pointer-events:none;color:' + CAT.accent + ';"></span>';
  bar += '<span style="font-weight:800;font-size:13px;flex:1;pointer-events:none;letter-spacing:0.4px;color:' + CAT.text + ';">偷懒小猫</span>';
  bar += '<button id="sl_comp_panel_btn" style="border:none;background:none;cursor:pointer;font-size:14px;color:' + CAT.sub + ';padding:4px 7px;border-radius:9px;">🐾</button></div>';
  // 信息行：角色名 + 胶囊
  bar += '<div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:8px 12px 6px;flex-shrink:0;height:18%;">';
  bar += '<span id="sl_comp_char" style="font-size:13px;color:' + CAT.text + ';font-weight:700;">--</span>';
  bar += '<span id="sl_comp_model" style="' + 'font-size:9.5px;line-height:1;padding:3.5px 9px;border-radius:999px;background:' + CAT.accent + '1F;color:' + CAT.accent + ';"></span>';
  bar += '<span id="sl_comp_profile" style="font-size:9.5px;line-height:1;padding:3.5px 9px;border-radius:999px;"></span>';
  bar += '</div>';
  // 状态行：状态点+状态+队列+模式
  bar += '<div style="padding:4px 12px;flex-shrink:0;display:flex;flex-direction:column;justify-content:center;height:20%;">';
  bar += '<div style="display:flex;align-items:center;gap:7px;font-size:11.5px;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + CAT.green + ';box-shadow:0 0 0 3px ' + CAT.green + '22;"></span><span id="sl_comp_status" style="font-weight:700;color:' + CAT.text + ';">打盹中 zZ</span><span style="color:' + CAT.mute + ';">·</span><span id="sl_comp_queue_txt" style="color:' + CAT.sub + ';">🐟 排队 0</span><span style="color:' + CAT.mute + ';">·</span><span id="sl_comp_mode" style="color:' + CAT.sub + ';">⚡ 自动</span></div>';
  bar += '<div id="sl_comp_event" style="font-size:10px;color:' + CAT.mute + ';margin-top:3px;">🐾 小猫候命中…</div></div>';
  // 按钮区
  bar += '<div style="display:flex;align-items:center;gap:6px;padding:6px 12px 7px;flex-shrink:0;height:22%;"><button id="sl_comp_gen" style="flex:1;font-size:12px;padding:0;height:36px;border:none;border-radius:13px;background:linear-gradient(135deg,' + CAT.accent + ',' + (CAT.accentHover || CAT.accent) + ');color:#fff;cursor:pointer;font-weight:800;box-shadow:' + CAT.btnShadow + ';">🐟 排图</button><button id="sl_comp_cancel" title="取消所有排图和分析；已交给 ComfyUI 的计算可能继续" aria-label="取消所有排图" style="flex:1.45;font-size:11px;padding:0;height:36px;border:1px solid ' + CAT.line + ';border-radius:13px;background:' + CAT.card + ';color:' + CAT.text + ';cursor:pointer;font-weight:700;">⏹ 取消全部</button><button id="sl_comp_auto" style="flex:1;font-size:12px;padding:0;height:36px;border:1px solid ' + CAT.line + ';border-radius:13px;background:' + CAT.card + ';color:' + CAT.text + ';cursor:pointer;font-weight:700;">⚡ 自动</button></div>';
  bar += '<form id="sl_comp_manual" style="display:flex;align-items:center;gap:6px;padding:0 12px 7px;flex-shrink:0;height:18%;">';
  bar += '<input id="sl_comp_floors" type="text" aria-label="手动排图楼层" placeholder="56,58-60,62" autocomplete="off" spellcheck="false" style="flex:1;min-width:0;width:0;height:100%;max-height:31px;margin:0;padding:0 8px;border:1px solid ' + CAT.line + ';border-radius:9px;background:' + CAT.bg + ';color:' + CAT.text + ';font:inherit;user-select:text;">';
  bar += '<button type="submit" style="flex-shrink:0;height:100%;max-height:31px;white-space:nowrap;padding:0 9px;border:1px solid ' + CAT.line + ';border-radius:9px;background:' + CAT.card + ';color:' + CAT.text + ';cursor:pointer;font-size:11px;font-weight:700;">手动排图</button></form></div>';
  _compactEl = jQuery(bar).appendTo('body');
  installCompactBehavior();
  jQuery('#sl_comp_header').on('click', function (e) { var was = _compDragMoved; _compDragMoved = false; if (jQuery(e.target).is('button') || was) return; panel.togglePanel(); });
  jQuery('#sl_comp_panel_btn').on('click', function (e) { e.stopPropagation(); panel.togglePanel(); });
  jQuery('#sl_comp_gen').on('click', function (e) { e.stopPropagation(); triggerGenAll(); });
  jQuery('#sl_comp_floors').on('keydown', event => event.stopPropagation());
  jQuery('#sl_comp_manual').on('submit', function (event) {
    event.preventDefault();
    event.stopPropagation();
    try {
      const { queued, analysing, skipped, needsArtist } = queueMessageFloors(this.querySelector('#sl_comp_floors').value);
      const status = [
        queued && ('已排队 ' + queued + ' 张'),
        analysing && (analysing + ' 层正在解析，完成后自动入队'),
        skipped && ('跳过 ' + skipped + ' 层（非 AI 回复或无占位符）'),
        needsArtist && (needsArtist + ' 层需要配置画师模型'),
      ].filter(Boolean).join(' · ');
      toast(queued || analysing ? 'success' : 'info', status || '指定图位已有图片或已在队列中');
      refreshCompactBar();
    } catch (error) { toast('warning', error.message); }
  });
  jQuery('#sl_comp_cancel').on('click', function (e) {
    e.stopPropagation(); const count = cancelPendingScans() + clearQueue();
    refreshCompactBar(); toast('info', count ? '已取消全部排图，可点击图位或排图按钮继续' : '当前没有待取消的排图');
  });
  jQuery('#sl_comp_auto').on('click', function (e) { e.stopPropagation(); settings.autoGen = settings.autoGen === 1 ? 0 : 1; resetAutomaticBacklog(); resetFrontendAutomaticBacklog(); saveSettings(); refreshCompactBar(); });
  _compactTimer = setInterval(refreshCompactBar, 3000); refreshCompactBar();
}
export function refreshCompactBar() {
  if (!_compactEl || !_compactEl.is(':visible')) return;
  var cn = getCharacterName() || '', hasChat = !!cn;
  jQuery('#sl_comp_char').text(hasChat ? cn : '还没有选角色喵~');
  jQuery('#sl_comp_model').text(hasChat ? String(modeBadge(getActiveMode())).toUpperCase() : '');
  var hp = chkProf();
  if (!hasChat) { jQuery('#sl_comp_profile').text('').hide(); }
  else {
    var _pn2 = 0; try { _pn2 = rosterEntries().length; } catch (e1) {}
    if (_pn2) jQuery('#sl_comp_profile').text('🐾 已建档 ' + _pn2 + ' 人').css({ background: CAT.green + '1F', color: CAT.green }).show();
    else jQuery('#sl_comp_profile').text('🐾 暂无档案').css({ background: CAT.bg, color: CAT.sub }).show();
  }
  var ss = getScannerStatus(), sm = { off: '猫尾收起', idle: '打盹中 zZ', waiting_body: '等故事来…', waiting_end: '猫爪码字中…', scanning: '思考小鱼干中…' };
  jQuery('#sl_comp_status').text(sm[ss] || ss);
  var dotColor = ss === 'scanning' ? CAT.yellow : (getQueueLength() > 0 ? CAT.accent : CAT.green);
  jQuery('#sl_comp_status').prev().css('background', dotColor).css('box-shadow', '0 0 0 3px ' + dotColor + '22');
  var ql = getQueueLength();
  jQuery('#sl_comp_queue_txt').text('🐟 排队 ' + ql);
  jQuery('#sl_comp_mode').text(settings.autoGen === 1 ? '⚡ 自动' : '🖐 手动');
  jQuery('#sl_comp_auto').text(settings.autoGen === 1 ? '⚡ 自动' : '🖐 手动');
  var cs = 'idle'; if (ss === 'scanning') cs = 'busy'; else if (ql > 0) cs = ql > 5 ? 'busy' : 'queuing';
  jQuery('#sl_cat_icon').html(catSVG(cs, 26));
  try { setHeadStatus(sm[ss] || ss, dotColor); } catch (e) {}
  var evText = '🐾 小猫候命中…';
  if (ss === 'scanning') evText = '🧠 脑内小剧场启动…';
  else if (ql > 0) evText = '🐟 小鱼干排队 ' + ql + ' 张';
  jQuery('#sl_comp_event').text(evText);
}
export function triggerGenAll() { var c = 0; jQuery('.sl_img_btn[data-prompt]:visible').each(function () { var b = jQuery(this); if (b.text().indexOf('排队') < 0 && b.text().indexOf('🔄') < 0 && b.text().indexOf('生成图片') >= 0) { b.trigger('click'); c++; } }); if (c === 0) toast('info', '没有可生成的小鱼干喵~'); else toast('success', '已排队 ' + c + ' 张图片喵~ ✨'); }

function installCompactBehavior() {
    const el = _compactEl[0], header = el.querySelector('#sl_comp_header');
    let collapsed = false, hovering = false, idleTimer, drag, position;
    const viewport = () => window.visualViewport || { width: window.innerWidth, height: window.innerHeight, offsetLeft: 0, offsetTop: 0 };
    const fullSize = v => ({ width: Math.max(1, Math.min(300, v.width - 16)), height: Math.max(1, Math.min(236, v.height - 16)) });
    const visibleSize = v => {
        if (!collapsed) return fullSize(v);
        const diameter = Math.max(1, Math.min(56, v.width, v.height));
        return { width: diameter, height: diameter };
    };
    // Store the inset from the nearer horizontal edge, independent of the panel width.
    function anchorAt(point, size, v, snap = false) {
        const left = point.x - (v.offsetLeft || 0), right = v.width - size.width - left;
        const side = left <= right ? 'left' : 'right';
        const inset = Math.max(0, Math.min(left, right));
        return { side, inset: snap && inset <= snapDistance ? 0 : inset, y: point.y - (v.offsetTop || 0) };
    }
    let anchor = null;
    try {
        const saved = JSON.parse(localStorage.getItem(compactPositionKey));
        if ((saved?.side === 'left' || saved?.side === 'right') && Number.isFinite(saved.inset) && Number.isFinite(saved.y)) {
            anchor = saved;
        } else if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) {
            const v = viewport(), size = fullSize(v);
            anchor = anchorAt(clampPosition(saved.x, saved.y, size.width, size.height, v), size, v);
        }
    } catch {}
    function layout() {
        const v = viewport(), size = visibleSize(v);
        const left = v.offsetLeft || 0, top = v.offsetTop || 0;
        const inset = anchor?.inset ?? 12;
        const x = left + (anchor?.side === 'left' ? inset : v.width - size.width - inset);
        const y = top + (anchor?.y ?? (v.width < 640 ? 12 : v.height - fullSize(v).height - 16));
        position = clampPosition(drag?.left ?? x, drag?.top ?? y, size.width, size.height, v);
        Object.assign(el.style, { left: position.x + 'px', top: position.y + 'px',
            width: size.width + 'px', height: size.height + 'px' });
    }
    function setCollapsed(value) {
        if (drag || collapsed === value) return;
        collapsed = value;
        el.classList.toggle('sl_compact_logo', value);
        layout();
    }
    function scheduleCollapse() {
        clearTimeout(idleTimer);
        if (!hovering && !drag && !el.querySelector(':focus-visible')) idleTimer = setTimeout(() => setCollapsed(true), 3000);
    }
    const enter = e => { if (e.pointerType === 'touch') return; hovering = true; clearTimeout(idleTimer); setCollapsed(false); };
    const leave = () => { hovering = false; scheduleCollapse(); };
    const focus = () => { clearTimeout(idleTimer); setCollapsed(false); };
    const blur = () => setTimeout(scheduleCollapse, 0);
    const down = e => {
        if (drag || e.button !== 0 || e.target.closest('button')) return;
        clearTimeout(idleTimer); _compDragMoved = false;
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY, start: position, left: position.x, top: position.y };
        header.setPointerCapture(e.pointerId); e.preventDefault();
    };
    const move = e => {
        if (!drag || drag.id !== e.pointerId) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) _compDragMoved = true;
        if (!_compDragMoved) return;
        drag.left = drag.start.x + dx;
        drag.top = drag.start.y + dy;
        layout();
    };
    const up = e => {
        if (!drag || drag.id !== e.pointerId) return;
        if (_compDragMoved && e.type === 'pointerup') {
            const v = viewport();
            if (Math.abs(drag.left - drag.start.x) > 4) anchor = anchorAt(position, visibleSize(v), v, true);
            else anchor = { side: anchor?.side ?? 'right', inset: anchor?.inset ?? 12, y: position.y - (v.offsetTop || 0) };
            try { localStorage.setItem(compactPositionKey, JSON.stringify(anchor)); } catch {}
        }
        drag = null;
        layout();
        scheduleCollapse();
    };
    const reset = e => {
        e.preventDefault();
        anchor = null;
        try { localStorage.removeItem(compactPositionKey); } catch {}
        layout();
    };
    const key = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(false); panel.togglePanel(); } };
    const clickLogo = e => { if (collapsed && !_compDragMoved) { e.stopImmediatePropagation(); setCollapsed(false); scheduleCollapse(); } };
    header.setAttribute('tabindex', '0'); header.setAttribute('role', 'button'); header.setAttribute('aria-label', '打开小猫生图面板（可拖动）');
    const style = document.createElement('style');
    style.textContent = '#sl_compact,#sl_compact *{box-sizing:border-box}#sl_compact.sl_compact_logo{border-radius:50%!important;overflow:hidden!important}#sl_compact.sl_compact_logo>:not(#sl_comp_header){display:none!important}#sl_compact.sl_compact_logo #sl_comp_header{border:0!important;padding:0!important;height:100%!important;justify-content:center!important}#sl_compact.sl_compact_logo #sl_comp_header> :not(#sl_cat_icon){display:none!important}#sl_compact #sl_comp_header:focus-visible{outline:2px solid currentColor;outline-offset:-3px}';
    document.head.appendChild(style);
    const listeners = [[el,'pointerenter',enter],[el,'pointerleave',leave],[el,'focusin',focus],[el,'focusout',blur],
        [header,'pointerdown',down],[header,'pointermove',move],[header,'pointerup',up],[header,'pointercancel',up],
        [header,'lostpointercapture',up],[header,'dblclick',reset],[header,'keydown',key],[window,'resize',layout],[window,'orientationchange',layout]];
    if (window.visualViewport) listeners.push([window.visualViewport,'resize',layout],[window.visualViewport,'scroll',layout]);
    for (const [target,name,fn] of listeners) target.addEventListener(name,fn);
    header.addEventListener('click',clickLogo,true);
    layout(); scheduleCollapse();
    _compactCleanup = () => {
        clearTimeout(idleTimer); style.remove(); header.removeEventListener('click',clickLogo,true);
        for (const [target,name,fn] of listeners) target.removeEventListener(name,fn);
    };
}
