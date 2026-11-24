// ── SillyImage Lab 子面板（AI 助理 / ComfyUI / 高级选项） ──
import { CAT } from './theme.js';
import { toast, esc, escAttr, sbtn, fi } from './utils.js';
import { settings, getDefaults, saveSettings, getSTHeaders } from '../settings.js';
import { STYLE_PRESETS } from '../comfyui.js';
import { pushPage } from './panel.js';  // 分层导航（仅函数体内使用，运行时安全）
var SUB_TITLES = { aux: 'AI 助理', comfy: 'ComfyUI 与工作流', advanced: '高级选项' };
export function openSubPanel(type) {
  pushPage(function (body) { fillSubPanel(type, body); }, SUB_TITLES[type] || '设置');
}
export function closeSubPanel(sub) { if (sub && sub.length) sub.remove(); }
export function fillSubPanel(type, body) {
  var f = fi();
  if (type === "aux") {
    var h = '';
    h += '<div style="margin-bottom:8px;"><div style="font-size:11px;color:' + CAT.sub + ';margin-bottom:2px;">📍 API 地址</div><input id="sl_aux_url" type="text" value="' + escAttr(settings.auxUrl || "") + '" style="' + f + '"></div>';
    h += '<div style="margin-bottom:8px;"><div style="font-size:11px;color:' + CAT.sub + ';margin-bottom:2px;">🔑 API Key</div><input id="sl_aux_key" type="password" value="' + escAttr(settings.auxKey || "") + '" style="' + f + '"></div>';
    h += '<div style="margin-bottom:8px;"><div style="font-size:11px;color:' + CAT.sub + ';margin-bottom:2px;">🧠 聊天分析模型</div><input id="sl_aux_model" type="text" value="' + escAttr(settings.auxModel || "") + '" style="' + f + '"></div>';
    h += '<div style="display:flex;gap:8px;align-items:center;"><button id="sl_test_aux" style="' + sbtn(CAT.accent) + '">🐾 测试连接</button><span id="sl_aux_status" style="font-size:11px;color:' + CAT.sub + ';"></span></div>';
    body.html(h);
    jQuery("#sl_aux_url").on("change input", function () { settings.auxUrl = jQuery(this).val(); saveSettings(); });
    jQuery("#sl_aux_key").on("change input", function () { settings.auxKey = jQuery(this).val(); saveSettings(); });
    jQuery("#sl_aux_model").on("change input", function () { settings.auxModel = jQuery(this).val(); saveSettings(); });
    jQuery("#sl_test_aux").on("click", async function () { var b = jQuery(this), s = jQuery("#sl_aux_status"); b.prop("disabled", true).text("测试中..."); try { var baseUrl = (jQuery("#sl_aux_url").val() || "").replace(/\/+$/, ""), url = /\/chat\/completions$/.test(baseUrl) ? baseUrl : baseUrl + "/chat/completions", key = jQuery("#sl_aux_key").val(), hd = { "Content-Type": "application/json" }; if (key) hd["Authorization"] = "Bearer " + key; var r = await fetch(url, { method: "POST", headers: hd, body: JSON.stringify({ model: jQuery("#sl_aux_model").val() || "default", messages: [{ role: "user", content: "hi" }], max_tokens: 3, stream: false }) }); if (r.ok) { s.css({ color: CAT.green }).text("连接成功喵~ ✨"); toast("success", "AI助理连接成功~"); } else { var t = await r.text().catch(function () { return ""; }); s.css({ color: CAT.red }).text("HTTP " + r.status); toast("error", "连接失败: " + r.status); } } catch (e) { s.css({ color: CAT.red }).text(e.message); toast("error", "连不上喵…"); } b.prop("disabled", false).text("🔌 测试连接"); });
  } else if (type === "comfy") {
    var h = '<div style="margin-bottom:8px;"><div style="font-size:11px;color:' + CAT.sub + ';margin-bottom:2px;">🎨 ComfyUI 地址</div><input id="sl_comfy_url" type="text" value="' + escAttr(settings.cUrl || "http://localhost:8181") + '" style="' + f + '"></div>';
    h += '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;"><button id="sl_test_comfy" style="' + sbtn(CAT.accent) + '">🐾 测试连接</button><span id="sl_comfy_status" style="font-size:11px;color:' + CAT.sub + ';"></span></div>';
    h += '<div style="font-size:11px;color:' + CAT.sub + ';margin-bottom:2px;">📂 工作流（下拉选中即切换，不用重新导入）</div>';
    h += '<select id="sl_wf_sel" style="' + f + 'margin-bottom:6px;"></select>';
    h += '<div style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap;"><button id="sl_wf_save" style="' + sbtn(CAT.green) + 'font-size:10px;">💾 保存</button><button id="sl_wf_save_as" style="' + sbtn(CAT.green) + 'font-size:10px;">➕ 另存为</button><button id="sl_wf_rename" style="' + sbtn(CAT.sub) + 'font-size:10px;">✏️ 重命名</button><button id="sl_wf_del" style="' + sbtn(CAT.red) + 'font-size:10px;">🗑 删除</button><button id="sl_wf_refresh" style="' + sbtn(CAT.sub) + 'font-size:10px;">🔄 刷新</button></div>';
    h += '<div style="font-size:11px;color:' + CAT.sub + ';margin-bottom:2px;">📄 工作流 JSON</div><textarea id="sl_comfy_wf" rows="5" style="width:100%;padding:8px;border:1px solid ' + CAT.line + ';border-radius:8px;background:' + CAT.card + ';font-family:monospace;font-size:11px;color:' + CAT.text + ';resize:vertical;box-sizing:border-box;">' + esc(settings.cWf || "") + "</textarea>";
    h += '<div style="display:flex;gap:6px;margin:6px 0;"><button id="sl_wf_import_btn" style="' + sbtn(CAT.sub) + 'font-size:10px;">📁 导入JSON</button><input type="file" id="sl_wf_import" accept=".json" style="display:none;"></div>';
    h += '<div style="font-size:11px;color:' + CAT.sub + ';margin-bottom:4px;">🎨 画风预设</div><select id="sl_style_preset" style="' + f + 'margin-bottom:8px;"><option value="">不使用预设</option>';
    for (var sk in STYLE_PRESETS) if (sk) h += '<option value="' + escAttr(sk) + '"' + (settings.stylePreset === sk ? " selected" : "") + ">" + esc(sk) + "</option>";
    h += "</select>";
    body.html(h);
    jQuery("#sl_comfy_url").on("change input", function () { settings.cUrl = jQuery(this).val(); saveSettings(); });
    jQuery("#sl_test_comfy").on("click", async function () { var b = jQuery(this), s = jQuery("#sl_comfy_status"); b.prop("disabled", true).text("测试中..."); try { var r = await fetch("/api/sd/comfy/ping", { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, getSTHeaders()), body: JSON.stringify({ url: jQuery("#sl_comfy_url").val() }) }); if (r.ok) { var d = await r.json().catch(function () { return {}; }); s.css({ color: CAT.green }).text("已连接" + (d.device ? " (" + d.device + ")" : "")); toast("success", "ComfyUI 连上啦~ ✨"); } else { var txt = await r.text().catch(function () { return ""; }); s.css({ color: CAT.red }).text("HTTP " + r.status); toast("error", "连接失败喵~"); } } catch (e) { s.css({ color: CAT.red }).text("连不上"); toast("error", "连不上喵…"); } b.prop("disabled", false).text("🔌 测试连接"); });
    // ── 工作流库：本地存档(settings.workflows) + ComfyUI服务器端(可选) ──
    if (!settings.workflows) settings.workflows = {};
    var _srvWfs = [];   // 服务器端工作流文件名（best-effort，拉不到就为空）
    function wfNames() { var ks = Object.keys(settings.workflows || {}); ks.sort(function (a, b) { return String(a).localeCompare(String(b), 'zh'); }); return ks; }
    function wfRaw() { return jQuery("#sl_comfy_wf").val() || ""; }
    function refreshWfSelect() {
      var sel = jQuery("#sl_wf_sel"); if (!sel.length) return;
      var cur = settings.cWfName || "", names = wfNames(), html = "";
      if (!names.length && !_srvWfs.length) html += '<option value="">（还没有工作流：点「📁 导入JSON」或粘贴后点「➕ 另存为」）</option>';
      for (var i = 0; i < names.length; i++) {
        var n = names[i];
        html += '<option value="' + escAttr(n) + '"' + (n === cur ? ' selected' : '') + '>💾 ' + esc(n) + (n === cur ? ' ✓当前' : '') + '</option>';
      }
      for (var j = 0; j < _srvWfs.length; j++) {
        var s = _srvWfs[j];
        if (names.indexOf(s) >= 0) continue;
        html += '<option value="srv::' + escAttr(s) + '">☁ ' + esc(s) + '（来自 ComfyUI，选中即导入）</option>';
      }
      sel.html(html);
    }
    function loadServerWfList(verbose) {
      return fetch('/api/sd/comfy/workflows', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, getSTHeaders()), body: '{}' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (list) { _srvWfs = Array.isArray(list) ? list : []; refreshWfSelect(); if (verbose) toast(_srvWfs.length ? 'success' : 'info', _srvWfs.length ? ('服务器端 ' + _srvWfs.length + ' 个工作流') : '服务器端没有工作流（不影响本地存档）'); })
        .catch(function () { if (verbose) toast('info', '拉取服务器工作流失败（不影响本地存档）'); });
    }
    refreshWfSelect();
    loadServerWfList(false);

    // 下拉选中 → 立即切换（服务器端条目先拉取再入库）
    jQuery("#sl_wf_sel").on("change", function () {
      var v = jQuery(this).val(); if (!v) return;
      if (v.indexOf('srv::') === 0) {
        var sname = v.slice(5);
        toast('info', '正在从 ComfyUI 拉取: ' + sname);
        fetch('/api/sd/comfy/workflow', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, getSTHeaders()), body: JSON.stringify({ file_name: sname }) })
          .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then(function (data) {
            var wf = typeof data === 'string' ? data : JSON.stringify(data);
            settings.workflows[sname] = wf; settings.cWf = wf; settings.cWfName = sname; saveSettings();
            jQuery("#sl_comfy_wf").val(wf); refreshWfSelect();
            toast('success', '已导入并切换: ' + sname);
          })
          .catch(function (err) { toast('error', '拉取失败: ' + err.message); refreshWfSelect(); });
        return;
      }
      var n = v, wf2 = settings.workflows[n];
      if (!wf2) { toast('error', '工作流不存在: ' + n); return; }
      settings.cWf = wf2; settings.cWfName = n; saveSettings();
      jQuery("#sl_comfy_wf").val(wf2);
      refreshWfSelect();
      toast('success', '已切换工作流: ' + n);
    });

    // 保存（覆盖当前选中的名字）
    jQuery("#sl_wf_save").on("click", function () {
      var raw = wfRaw(); if (!raw) { toast('info', '工作流是空的喵~'); return; }
      var n = settings.cWfName || jQuery("#sl_wf_sel").val() || "";
      if (!n || n.indexOf('srv::') === 0) { toast('info', '还没起名字，用「➕ 另存为」'); return; }
      settings.workflows[n] = raw; settings.cWf = raw; settings.cWfName = n; saveSettings(); refreshWfSelect();
      toast('success', '已保存: ' + n);
    });

    // 另存为
    jQuery("#sl_wf_save_as").on("click", function () {
      var raw = wfRaw(); if (!raw) { toast('info', '工作流是空的喵~'); return; }
      var def = settings.cWfName || ("工作流" + (wfNames().length + 1));
      var n = window.prompt('给这个工作流起个名字：', def);
      if (n == null) return;
      n = String(n).trim(); if (!n) return;
      if (settings.workflows[n] != null && !window.confirm('「' + n + '」已存在，覆盖？')) return;
      settings.workflows[n] = raw; settings.cWf = raw; settings.cWfName = n; saveSettings(); refreshWfSelect();
      toast('success', '已另存为: ' + n);
    });

    // 重命名
    jQuery("#sl_wf_rename").on("click", function () {
      var old = settings.cWfName || jQuery("#sl_wf_sel").val() || "";
      if (!old || settings.workflows[old] == null) { toast('info', '先在下拉里选一个工作流'); return; }
      var n = window.prompt('新名字：', old);
      if (n == null) return;
      n = String(n).trim();
      if (!n || n === old) return;
      if (settings.workflows[n] != null && !window.confirm('「' + n + '」已存在，覆盖？')) return;
      settings.workflows[n] = settings.workflows[old];
      delete settings.workflows[old];
      settings.cWfName = n; saveSettings(); refreshWfSelect();
      toast('success', '已重命名: ' + old + ' → ' + n);
    });

    // 删除
    jQuery("#sl_wf_del").on("click", function () {
      var n = settings.cWfName || jQuery("#sl_wf_sel").val() || "";
      if (!n || settings.workflows[n] == null) { toast('info', '先在下拉里选一个工作流'); return; }
      if (!window.confirm('删除工作流「' + n + '」？（只删插件存档，不动 ComfyUI 里的文件）')) return;
      delete settings.workflows[n];
      if (settings.cWfName === n) settings.cWfName = '';
      saveSettings(); refreshWfSelect();
      toast('success', '已删除: ' + n);
    });

    jQuery("#sl_wf_refresh").on("click", function () { loadServerWfList(true); });

    jQuery("#sl_wf_import_btn").on("click", function () { jQuery("#sl_wf_import").trigger("click"); });
    jQuery("#sl_wf_import").on("change", function () {
      var file = this.files[0]; if (!file) return;
      var input = this;
      var reader = new FileReader();
      reader.onload = function (ev) {
        var txt = String(ev.target.result || "");
        var base = String(file.name || '').replace(/\.json$/i, '').trim() || ('导入' + Date.now());
        var n = base;
        if (settings.workflows[n] != null) {
          if (window.confirm('「' + base + '」已存在，覆盖？\n（点取消 = 存成新名字）')) { /* 覆盖 */ }
          else { var i = 2; while (settings.workflows[base + '(' + i + ')'] != null) i++; n = base + '(' + i + ')'; }
        }
        settings.workflows[n] = txt; settings.cWf = txt; settings.cWfName = n; saveSettings();
        jQuery("#sl_comfy_wf").val(txt); refreshWfSelect();
        toast('success', '已导入并入库: ' + n);
      };
      reader.readAsText(file);
      input.value = '';
    });
    jQuery("#sl_style_preset").on("change", function () { settings.stylePreset = jQuery(this).val(); saveSettings(); });
  } else if (type === "advanced") {
    var h = '<div style="background:' + CAT.card + ';border-radius:10px;padding:12px;margin-bottom:8px;border:1px solid ' + CAT.line + ';">';
    h += '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" id="sl_nsfw"' + (settings.nsfwEnhance ? " checked" : "") + '><span style="font-size:12px;color:' + CAT.text + ';">🔞 NSFW 增强模式</span></label>';
    h += '<div style="margin-top:8px;"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="radio" name="sl_story" value="narrative"' + (settings.storyMode !== "comic" ? " checked" : "") + '><span style="font-size:12px;color:' + CAT.text + ';">📖 叙事模式</span></label></div><div><label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="radio" name="sl_story" value="comic"' + (settings.storyMode === "comic" ? " checked" : "") + '><span style="font-size:12px;color:' + CAT.text + ';">📱 漫画模式</span></label></div></div>';
    h += '<div style="background:' + CAT.card + ';border-radius:10px;padding:12px;border:1px solid ' + CAT.line + ';">';
    h += '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" id="sl_debug"' + (settings.debugMode ? " checked" : "") + '><span style="font-size:12px;color:' + CAT.text + ';">🐛 Debug 模式</span></label></div>';
    h += '<div style="background:' + CAT.card + ';border-radius:10px;padding:12px;margin-top:8px;border:1px solid ' + CAT.line + ';">';
    h += '<div style="font-size:11px;color:' + CAT.sub + ';">📜 画师每次只接收本图占位符及匹配的人物档案、造型。</div></div>';
    h += '<div style="background:' + CAT.card + ';border-radius:10px;padding:12px;margin-top:8px;border:1px solid ' + CAT.line + ';">';
    h += '<button id="sl_btn_reset" style="width:100%;' + sbtn(CAT.red) + '">重置插件偏好</button></div>';
    body.html(h);
    jQuery("#sl_nsfw").on("change", function () { settings.nsfwEnhance = jQuery(this).is(":checked"); saveSettings(); });
    jQuery("input[name=sl_story]").on("change", function () { settings.storyMode = jQuery(this).val(); saveSettings(); });
    jQuery("#sl_debug").on("change", function () { settings.debugMode = jQuery(this).is(":checked"); saveSettings(); });
    jQuery("#sl_btn_reset").on("click", function () {
      if (!confirm('恢复插件默认偏好？连接配置和本机工作流列表也会恢复默认值。')) return;
      Object.assign(settings, getDefaults()); saveSettings();
      toast('success', '插件偏好已恢复，重新打开面板查看');
    });
  }
}
