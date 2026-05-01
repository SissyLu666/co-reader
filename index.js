// ============================================================
//  Co-Reader V1.0  ·  SillyTavern 共读批注扩展
//  v1 新增：多书书架 · 自定义封面 · 进度条+书签点
//           字词解释/翻译 · TTS朗读 · 批注链接
//           四套主题包 · 共读模式(注入对话上下文)
//           导出角色记忆 · 导入批注JSON · 批注统计
// ============================================================

import {
  saveSettingsDebounced,
  getRequestHeaders,
  generateQuietPrompt,
} from "../../../../script.js";
import {
  extension_settings,
  getContext,
  setExtensionPrompt,
} from "../../../../script.js";

const EXT = "co-reader";
const RMODE_ID = "co-reader-reading-ctx";

// ─────────────────────────────────────────────────────────────
//  DOM 快捷选择器
// ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ─────────────────────────────────────────────────────────────
//  主题预设
// ─────────────────────────────────────────────────────────────
const THEMES = {
  "深夜猫咖": {
    bgColor:"#1e1e2e", textColor:"#cdd6f4", accentColor:"#cba6f7",
    panelBg:"#181825", sideBg:"#11111b",
    border:"rgba(255,255,255,.1)",
    btnBg:"rgba(255,255,255,.08)", btnHov:"rgba(255,255,255,.16)",
    inputBg:"rgba(255,255,255,.06)", cardBg:"rgba(255,255,255,.04)",
    mkU:"rgba(203,166,247,.22)", mkA:"rgba(137,220,235,.16)", mkO:"rgba(166,227,161,.12)",
    isDark:true
  },
  "赛博霓虹": {
    bgColor:"#0d0d1a", textColor:"#e2e0ff", accentColor:"#00ffcc",
    panelBg:"#08080f", sideBg:"#050510",
    border:"rgba(0,255,204,.18)",
    btnBg:"rgba(0,255,204,.08)", btnHov:"rgba(0,255,204,.18)",
    inputBg:"rgba(0,255,204,.06)", cardBg:"rgba(0,255,204,.04)",
    mkU:"rgba(0,255,204,.15)", mkA:"rgba(255,0,200,.12)", mkO:"rgba(255,220,0,.1)",
    isDark:true
  },
  "日系米白": {
    bgColor:"#fafaf4", textColor:"#2a2a2a", accentColor:"#7c6f8e",
    panelBg:"#f0f0e6", sideBg:"#e8e8de",
    border:"rgba(0,0,0,.1)",
    btnBg:"rgba(0,0,0,.06)", btnHov:"rgba(0,0,0,.12)",
    inputBg:"rgba(0,0,0,.05)", cardBg:"rgba(0,0,0,.03)",
    mkU:"rgba(124,111,142,.2)", mkA:"rgba(100,150,200,.14)", mkO:"rgba(80,160,80,.12)",
    isDark:false
  },
  "复古牛皮纸": {
    bgColor:"#f4edd8", textColor:"#3a2c1e", accentColor:"#8b4513",
    panelBg:"#ede6ce", sideBg:"#e6dfc6",
    border:"rgba(139,69,19,.14)",
    btnBg:"rgba(139,69,19,.07)", btnHov:"rgba(139,69,19,.14)",
    inputBg:"rgba(139,69,19,.05)", cardBg:"rgba(139,69,19,.04)",
    mkU:"rgba(139,69,19,.18)", mkA:"rgba(100,120,60,.14)", mkO:"rgba(60,100,150,.1)",
    isDark:false
  },
};

// ─────────────────────────────────────────────────────────────
//  默认数据
// ─────────────────────────────────────────────────────────────
function mkDef() {
  return {
    library: {},
    currentBookId: null,
    settings: {
      themeName:    "深夜猫咖",
      bgColor:      "#1e1e2e",
      textColor:    "#cdd6f4",
      accentColor:  "#cba6f7",
      font:         "Georgia,'Noto Serif SC',serif",
      fontSize:     "17px",
      annFont:      "'Noto Sans SC',Arial,sans-serif",
      annFontSize:  "13px",
      lineHeight:   "1.95",
      autoAiReply:  true,
      ttsEnabled:   false,
      ttsRate:      1.0,
      readingMode:  false,
      translateLang:"中文",
      customApiUrl: "",
    },
  };
}

// ─────────────────────────────────────────────────────────────
//  状态管理
// ─────────────────────────────────────────────────────────────
function S() {
  if (!extension_settings[EXT]) extension_settings[EXT] = mkDef();
  const def = mkDef(), s = extension_settings[EXT];
  if (!s.library)  s.library  = {};
  if (!s.settings) s.settings = def.settings;
  Object.keys(def.settings).forEach(k => {
    if (s.settings[k] === undefined) s.settings[k] = def.settings[k];
  });
  return s;
}

const save = () => saveSettingsDebounced();

function curBook() {
  const id = S().currentBookId;
  return id ? S().library[id] : null;
}

// ─────────────────────────────────────────────────────────────
//  v2 数据迁移
// ─────────────────────────────────────────────────────────────
function migrate() {
  const s = extension_settings[EXT];
  if (s?.text) {
    const id = `book_${Date.now()}`;
    if (!s.library) s.library = {};
    s.library[id] = {
      id, title: s.fileName || "导入书籍", text: s.text, cover: null,
      annotations: s.annotations || {}, bookmarks: s.bookmarks || {},
      readPos: s.readPos || 0, createdAt: Date.now(), updatedAt: Date.now(),
    };
    s.currentBookId = id;
    ["text","fileName","annotations","bookmarks","readPos"].forEach(k => delete s[k]);
    save();
  }
}

// ─────────────────────────────────────────────────────────────
//  角色卡联动
// ─────────────────────────────────────────────────────────────
function getCharInfo() {
  try {
    const ctx = getContext();
    const c = ctx.characters?.[ctx.characterId];
    if (!c) return null;
    const pers = (c.personality || c.description || "").slice(0, 200);
    return {
      name: c.name,
      sys:  `你正在扮演"${c.name}"。角色性格：${pers}`,
    };
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────
//  TTS（Web Speech API）
// ─────────────────────────────────────────────────────────────
let ttsActive = false;

function ttsRead(text) {
  if (!S().settings.ttsEnabled || !text) return;
  ttsStop();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang  = "zh-CN";
  utter.rate  = parseFloat(S().settings.ttsRate) || 1.0;
  utter.onstart = () => { ttsActive = true;  syncTtsBtns(); };
  utter.onend   = () => { ttsActive = false; syncTtsBtns(); };
  utter.onerror = () => { ttsActive = false; syncTtsBtns(); };
  speechSynthesis.speak(utter);
}

function ttsStop() {
  speechSynthesis.cancel();
  ttsActive = false;
  syncTtsBtns();
}

function syncTtsBtns() {
  document.querySelectorAll(".cr-tts-btn").forEach(b => {
    b.textContent = ttsActive ? "⏹" : "🔊";
  });
}

// ─────────────────────────────────────────────────────────────
//  进度条
// ─────────────────────────────────────────────────────────────
function updateProgress() {
  const cw   = $("cr-cw");
  const fill = $("cr-prog-fill");
  const bkEl = $("cr-prog-bk");
  const pctEl= $("cr-prog-pct");
  if (!cw || !fill) return;

  const pct = cw.scrollHeight <= cw.clientHeight
    ? 0
    : (cw.scrollTop / (cw.scrollHeight - cw.clientHeight)) * 100;

  fill.style.width = `${pct.toFixed(1)}%`;
  if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;

  // 书签点
  if (bkEl) {
    const book = curBook();
    bkEl.innerHTML = Object.keys(book?.bookmarks || {}).map(idx => {
      const el = document.querySelector(`.crp[data-p="${idx}"]`);
      if (!el) return "";
      const pos = ((el.offsetTop / cw.scrollHeight) * 100).toFixed(1);
      return `<span class="cr-bk-dot" style="left:${pos}%" data-p="${idx}" title="§${+idx+1}"></span>`;
    }).join("");
    bkEl.querySelectorAll(".cr-bk-dot").forEach(d =>
      d.addEventListener("click", () => {
        document.querySelector(`.crp[data-p="${d.dataset.p}"]`)
          ?.scrollIntoView({ behavior:"smooth", block:"center" });
      })
    );
  }

  const book = curBook();
  if (book) { book.readPos = cw.scrollTop; save(); }
}

// ─────────────────────────────────────────────────────────────
//  共读模式
// ─────────────────────────────────────────────────────────────
async function toggleReadingMode() {
  S().settings.readingMode = !S().settings.readingMode;
  save();
  refreshRMBtn();
  if (!S().settings.readingMode) {
    try { setExtensionPrompt(RMODE_ID, "", 1, 0); } catch {}
    toast("已退出共读模式");
    return;
  }
  await syncReadingCtx();
  toast("✓ 共读模式开启，AI 将在对话中联系本书内容");
}

async function syncReadingCtx() {
  const book = curBook();
  if (!book || !S().settings.readingMode) return;
  const ch = getCharInfo();
  const cw = $("cr-cw");
  const pct = (cw && cw.scrollHeight > cw.clientHeight)
    ? Math.round(cw.scrollTop / (cw.scrollHeight - cw.clientHeight) * 100) : 0;
  const annSummary = Object.values(book.annotations || {})
    .sort((a,b) => b.ts - a.ts).slice(0, 8)
    .map(a => `· 「${a.selectedText.slice(0,18)}」→ ${a.text.slice(0,55)}`)
    .join("\n");

  const ctx = [
    "【共读模式激活】",
    `当前书目：《${book.title}》`,
    ch ? `角色：${ch.name}` : "",
    `阅读进度：${pct}%`,
    annSummary ? `近期批注：\n${annSummary}` : "",
    "\n请在与用户对话时自然联系本书内容，可深入探讨书中观点。",
  ].filter(Boolean).join("\n");

  try { setExtensionPrompt(RMODE_ID, ctx, 1, 0); }
  catch (e) { console.warn("[Co-Reader] setExtensionPrompt:", e); }
}

function refreshRMBtn() {
  const btn = $("cr-rmb");
  if (!btn) return;
  const on = S().settings.readingMode;
  btn.textContent = on ? "🎭 共读中" : "🎭 共读模式";
  btn.classList.toggle("crb-on", on);
}

// ─────────────────────────────────────────────────────────────
//  导出到角色记忆
// ─────────────────────────────────────────────────────────────
function exportToMemory() {
  const book = curBook();
  if (!book) { toast("请先打开一本书"); return; }
  const anns = Object.values(book.annotations || {});
  if (!anns.length) { toast("当前书没有批注"); return; }
  const lines = [
    `【共读记忆：《${book.title}》】`,
    `批注共 ${anns.length} 条`,
    "",
    ...anns.slice(0,12).map(a => {
      const aiLine = (a.thread||[]).filter(r=>r.role==="ai").map(r=>r.text).join("；");
      return `▷「${a.selectedText.slice(0,22)}」\n  ${a.text}${aiLine ? `\n  AI：${aiLine.slice(0,55)}` : ""}`;
    }),
  ].join("\n");
  navigator.clipboard?.writeText(lines).catch(()=>{});
  showMemModal(lines);
}

function showMemModal(text) {
  $("cr-mm")?.remove();
  const m = document.createElement("div");
  m.id = "cr-mm";
  m.innerHTML = `
    <div id="cr-mm-box">
      <div class="cr-modal-hd">
        <span>🧠 导出至角色记忆</span>
        <button class="crb crb-sm" id="cr-mm-x">✕</button>
      </div>
      <p class="cr-modal-tip">内容已复制到剪贴板。将以下内容粘贴至角色卡「记忆」或「世界信息」中：</p>
      <textarea id="cr-mm-ta" readonly>${esc(text)}</textarea>
      <div class="cr-modal-ft">
        <button class="crb crb-p" id="cr-mm-cp">📋 再次复制</button>
        <button class="crb" id="cr-mm-cl">关闭</button>
      </div>
    </div>`;
  document.body.appendChild(m);
  const close = () => m.remove();
  $("cr-mm-x").onclick = $("cr-mm-cl").onclick = close;
  $("cr-mm-cp").onclick = () => { navigator.clipboard?.writeText(text); toast("✓ 已复制"); };
}

// ─────────────────────────────────────────────────────────────
//  初始化
// ─────────────────────────────────────────────────────────────
jQuery(async () => {
  if (!extension_settings[EXT]) extension_settings[EXT] = mkDef();
  migrate();
  injectBall();
  injectPanel();
  applyTheme();
  if (S().settings.readingMode && curBook()) syncReadingCtx();
});

// ─────────────────────────────────────────────────────────────
//  悬浮球（Pointer Events，桌面+触摸通用）
// ─────────────────────────────────────────────────────────────
function injectBall() {
  if ($("cr-ball")) return;
  const ball = document.createElement("div");
  ball.id = "cr-ball"; ball.innerHTML = "📖";
  document.body.appendChild(ball);
  let moved=false, ox=0, oy=0, sx=0, sy=0;
  ball.addEventListener("pointerdown", e => {
    ball.setPointerCapture(e.pointerId);
    const r = ball.getBoundingClientRect();
    ox=e.clientX-r.left; oy=e.clientY-r.top;
    sx=e.clientX; sy=e.clientY; moved=false; e.preventDefault();
  });
  ball.addEventListener("pointermove", e => {
    if (Math.hypot(e.clientX-sx, e.clientY-sy) > 8) {
      moved=true;
      ball.style.right=ball.style.bottom="auto";
      ball.style.left=`${e.clientX-ox}px`;
      ball.style.top=`${e.clientY-oy}px`;
    }
  });
  ball.addEventListener("pointerup", () => { if (!moved) togglePanel(); });
}

// ─────────────────────────────────────────────────────────────
//  主面板 HTML
// ─────────────────────────────────────────────────────────────
function injectPanel() {
  if ($("cr-panel")) return;
  const panel = document.createElement("div");
  panel.id = "cr-panel"; panel.style.display = "none";
  panel.innerHTML = `
<div id="cri">

  <!-- 工具栏 -->
  <div id="cr-tb">
    <div id="cr-tb-l">
      <span id="cr-title">📖 共读</span>
      <button class="crb crb-sm" id="cr-libbtn" title="书架">🗂 书架</button>
      <button class="crb crb-sm" id="cr-rmb">🎭 共读模式</button>
    </div>
    <div id="cr-acts">
      <label class="crb crb-sm" title="导入 TXT/MD">
        📂<span class="crl"> 导入</span>
        <input type="file" id="cr-file" accept=".txt,.md" style="display:none">
      </label>
      <label class="crb crb-sm" title="导入批注 JSON">
        📋<span class="crl"> 导批注</span>
        <input type="file" id="cr-afile" accept=".json" style="display:none">
      </label>
      <button class="crb crb-sm" id="cr-autoann">🤖<span class="crl"> 全文批注</span></button>
      <button class="crb crb-sm" id="cr-ej">⬇<span class="crl"> JSON</span></button>
      <button class="crb crb-sm" id="cr-et">⬇<span class="crl"> TXT</span></button>
      <button class="crb crb-sm" id="cr-mmbtn" title="导出角色记忆">🧠</button>
      <button class="crb crb-sm" id="cr-sb" title="搜索">🔍</button>
      <button class="crb crb-sm" id="cr-stog" title="批注栏">📋</button>
      <button class="crb crb-sm" id="cr-cfgb" title="设置">⚙</button>
      <button class="crb crb-sm" id="cr-x">✕</button>
    </div>
  </div>

  <!-- 书架 -->
  <div id="cr-lib" style="display:none">
    <div id="cr-lib-hd">
      <span>📚 书架</span>
      <label class="crb crb-sm">➕ 新书
        <input type="file" id="cr-lfile" accept=".txt,.md" style="display:none">
      </label>
    </div>
    <div id="cr-lib-grid"></div>
  </div>

  <!-- 阅读器 -->
  <div id="cr-reader" style="display:none">

    <!-- 搜索 -->
    <div id="cr-sb-bar" style="display:none">
      <input id="cr-si" placeholder="搜索批注…" autocomplete="off">
      <select id="cr-flt">
        <option value="">全部</option>
        <option value="user">💬 我的</option>
        <option value="ai">🤖 AI选批</option>
        <option value="auto">✨ 全文批注</option>
      </select>
      <button class="crb crb-sm" id="cr-sclr">✕</button>
    </div>

    <!-- 进度条 -->
    <div id="cr-prog">
      <div id="cr-pfill"></div>
      <div id="cr-pbk"></div>
      <span id="cr-prog-pct">0%</span>
    </div>

    <!-- 正文 + 侧边栏 -->
    <div id="cr-main">
      <div id="cr-cw">
        <div id="cr-c"><div class="cr-hint">从书架选择书目，或点击 📂 导入新书</div></div>
      </div>
      <div id="cr-side">
        <div id="cr-side-hd">批注列表</div>
        <div id="cr-al"></div>
      </div>
    </div>

    <!-- 统计栏 -->
    <div id="cr-stats"></div>
  </div>

  <!-- 设置 -->
  <div id="cr-cfg" style="display:none">
    <h4>⚙ 设置</h4>
    <div class="cfg-row">

      <div class="cfg-sec">
        <h5>🎨 主题包</h5>
        <div id="cr-themes">
          ${Object.keys(THEMES).map(n=>`<button class="crb crb-sm cr-tbtn" data-t="${n}">${n}</button>`).join("")}
        </div>
        <h5>🖊 自定义</h5>
        <label>背景色  <input type="color" data-k="bgColor"></label>
        <label>文字色  <input type="color" data-k="textColor"></label>
        <label>强调色  <input type="color" data-k="accentColor"></label>
        <label>正文字体 <input type="text" data-k="font" placeholder="Georgia,serif"></label>
        <label>正文字号 <input type="text" data-k="fontSize" placeholder="17px"></label>
        <label>批注字体 <input type="text" data-k="annFont"></label>
        <label>批注字号 <input type="text" data-k="annFontSize" placeholder="13px"></label>
        <label>行高     <input type="text" data-k="lineHeight" placeholder="1.95"></label>
      </div>

      <div class="cfg-sec">
        <h5>🤖 AI & 功能</h5>
        <label>自定义API   <input type="text" data-k="customApiUrl" placeholder="留空=ST当前API"></label>
        <label>翻译目标语  <input type="text" data-k="translateLang" placeholder="中文"></label>
        <label class="chkl"><input type="checkbox" data-k="autoAiReply"> 批注后自动 AI 回复</label>
        <label class="chkl"><input type="checkbox" data-k="ttsEnabled"> 启用 TTS 朗读</label>
        <label>TTS 语速
          <input type="range" data-k="ttsRate" min="0.5" max="2.0" step="0.1">
        </label>
      </div>

    </div>
    <div class="cfg-ft">
      <button class="crb crb-p" id="cr-csave">保存</button>
      <button class="crb" id="cr-crst">恢复默认</button>
      <button class="crb" id="cr-ccls">关闭</button>
    </div>
  </div>

</div>`;
  document.body.appendChild(panel);
  bindEvents();
}

// ─────────────────────────────────────────────────────────────
//  事件绑定
// ─────────────────────────────────────────────────────────────
function bindEvents() {
  $("cr-x").onclick     = togglePanel;
  $("cr-libbtn").onclick= toggleLib;
  $("cr-rmb").onclick   = toggleReadingMode;
  $("cr-mmbtn").onclick = exportToMemory;

  $("cr-file").addEventListener("change",  e => importFile(e, false));
  $("cr-lfile").addEventListener("change", e => importFile(e, true));
  $("cr-afile").addEventListener("change", importAnns);

  $("cr-autoann").onclick = autoAnnotate;
  $("cr-ej").onclick      = exportJson;
  $("cr-et").onclick      = exportTxt;

  $("cr-cfgb").onclick    = () => toggleCfg();
  $("cr-csave").onclick   = saveCfg;
  $("cr-crst").onclick    = resetCfg;
  $("cr-ccls").onclick    = () => toggleCfg(false);

  $("cr-stog").onclick = () => $("cr-side").classList.toggle("cr-so");

  // 搜索栏
  $("cr-sb").onclick = () => {
    const b = $("cr-sb-bar");
    b.style.display = b.style.display === "none" ? "flex" : "none";
    if (b.style.display !== "none") $("cr-si").focus();
  };
  $("cr-si").addEventListener("input", renderList);
  $("cr-flt").addEventListener("change", renderList);
  $("cr-sclr").onclick = () => { $("cr-si").value=""; renderList(); };

  // 主题按钮
  document.querySelectorAll(".cr-tbtn").forEach(btn =>
    btn.addEventListener("click", () => {
      const t = THEMES[btn.dataset.t];
      if (!t) return;
      S().settings.themeName = btn.dataset.t;
      S().settings.bgColor   = t.bgColor;
      S().settings.textColor = t.textColor;
      S().settings.accentColor = t.accentColor;
      applyTheme(); save();
      refreshThemeBtns();
      toast(`✓ 主题：${btn.dataset.t}`);
    })
  );

  // 进度条滚动
  $("cr-cw").addEventListener("scroll", () => requestAnimationFrame(updateProgress));

  // 文字选中
  const c = $("cr-c");
  c.addEventListener("mouseup",  () => setTimeout(onSelect, 30));
  c.addEventListener("touchend", () => setTimeout(onSelect, 280));
}

// ─────────────────────────────────────────────────────────────
//  面板 & 视图切换
// ─────────────────────────────────────────────────────────────
function togglePanel() {
  const p = $("cr-panel");
  if (p.style.display !== "none") {
    p.style.display = "none"; return;
  }
  p.style.display = "flex";
  curBook() ? showReader() : showLib();
  refreshRMBtn();
}

function showLib() {
  $("cr-lib").style.display    = "flex";
  $("cr-reader").style.display = "none";
  renderLib();
}

function showReader() {
  $("cr-lib").style.display    = "none";
  $("cr-reader").style.display = "flex";
  if (curBook() && $("cr-c").querySelectorAll(".crp").length === 0) renderText();
  setTimeout(() => {
    const cw = $("cr-cw");
    if (cw && curBook()) cw.scrollTop = curBook().readPos || 0;
    updateProgress();
  }, 80);
}

function toggleLib() {
  $("cr-lib").style.display !== "none" && curBook()
    ? showReader()
    : showLib();
}

function toggleCfg(show) {
  const el = $("cr-cfg");
  show = show ?? el.style.display === "none";
  el.style.display = show ? "block" : "none";
  if (show) loadCfgForm();
}

// ─────────────────────────────────────────────────────────────
//  书架渲染
// ─────────────────────────────────────────────────────────────
function renderLib() {
  const grid = $("cr-lib-grid");
  if (!grid) return;
  const books = Object.values(S().library).sort((a,b) => (b.updatedAt||0)-(a.updatedAt||0));

  if (!books.length) {
    grid.innerHTML = `<div class="lib-empty">📚 书架空空<br>点击 ➕ 新书 导入第一本</div>`;
    return;
  }

  grid.innerHTML = books.map(b => {
    const ac = Object.keys(b.annotations||{}).length;
    const bc = Object.keys(b.bookmarks||{}).length;
    const dt = b.updatedAt ? new Date(b.updatedAt).toLocaleDateString("zh-CN") : "未读";
    const cs = b.cover
      ? `style="background-image:url(${b.cover});background-size:cover;background-position:center"`
      : "";
    return `
      <div class="bk-card" data-id="${b.id}">
        <div class="bk-cover" ${cs} onclick="crOpenBook('${b.id}')">
          ${!b.cover ? `<div class="bk-cover-ph">${esc(b.title.slice(0,4))}</div>` : ""}
          <label class="bk-cover-up crb" title="更换封面">
            🖼<input type="file" accept="image/*" onchange="crUploadCover('${b.id}',this)" style="display:none">
          </label>
        </div>
        <div class="bk-info" onclick="crOpenBook('${b.id}')">
          <div class="bk-title">${esc(b.title)}</div>
          <div class="bk-meta">💬${ac} · ★${bc} · ${dt}</div>
        </div>
        <button class="bk-del crb crb-sm crb-del" onclick="crDelBook('${b.id}')" title="删除">🗑</button>
      </div>`;
  }).join("");
}

window.crOpenBook = id => {
  const b = S().library[id];
  if (!b) return;
  S().currentBookId = id;
  b.updatedAt = Date.now();
  save(); showReader(); renderText();
  toast(`📖 《${b.title}》`);
};

window.crDelBook = id => {
  const b = S().library[id];
  if (!b || !confirm(`确认删除《${b.title}》？`)) return;
  delete S().library[id];
  if (S().currentBookId === id) S().currentBookId = null;
  save(); renderLib(); toast("已删除");
};

window.crUploadCover = (id, input) => {
  const f = input.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = e => {
    S().library[id].cover = e.target.result;
    save(); renderLib(); toast("✓ 封面已更新");
  };
  r.readAsDataURL(f);
  input.value = "";
};

// ─────────────────────────────────────────────────────────────
//  文件导入
// ─────────────────────────────────────────────────────────────
function importFile(e, stayLib = false) {
  const file = e.target.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = ev => {
    const id = `book_${Date.now()}`;
    S().library[id] = {
      id, title: file.name.replace(/\.(txt|md)$/i,""), text: ev.target.result,
      cover: null, annotations:{}, bookmarks:{},
      readPos:0, createdAt:Date.now(), updatedAt:Date.now(),
    };
    S().currentBookId = id;
    save();
    stayLib ? renderLib() : (showReader(), renderText());
    toast(`✓ 已导入《${S().library[id].title}》`);
  };
  r.readAsText(file,"UTF-8");
  e.target.value = "";
}

function importAnns(e) {
  const file = e.target.files[0];
  if (!file) return;
  const book = curBook();
  if (!book) { toast("请先打开一本书"); return; }
  const r = new FileReader();
  r.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      let n = 0;
      Object.values(data.annotations || {}).forEach(a => {
        const k = `ann_${a.pIdx}_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;
        book.annotations[k] = {...a, key:k, refs:a.refs||[]};
        n++;
      });
      save(); renderText(); toast(`✓ 导入 ${n} 条批注`);
    } catch { toast("解析失败，请检查 JSON 格式"); }
  };
  r.readAsText(file,"UTF-8");
  e.target.value = "";
}

// ─────────────────────────────────────────────────────────────
//  文本渲染
// ─────────────────────────────────────────────────────────────
function renderText() {
  const el = $("cr-c");
  if (!el) return;
  const book = curBook();
  if (!book) {
    el.innerHTML = `<div class="cr-hint">从书架选择书目，或点击 📂 导入新书</div>`;
    return;
  }

  const paras = book.text.split(/\r?\n/);
  let html = "";
  paras.forEach((p, i) => {
    if (!p.trim()) { html += `<div class="crp cre" data-p="${i}"></div>`; return; }
    let line = esc(p);
    // 批注高亮
    Object.values(book.annotations)
      .filter(a => a.pIdx === i)
      .forEach(a => {
        const e2 = esc(a.selectedText);
        line = line.replace(e2, `<mark class="crm crm-${a.origin}" data-k="${a.key}">${e2}</mark>`);
      });
    const bk = book.bookmarks?.[i] ? " crp-bk" : "";
    html += `<div class="crp${bk}" data-p="${i}">${line}</div>`;
  });
  el.innerHTML = html;

  // 点击高亮 → 跳批注卡
  el.querySelectorAll(".crm").forEach(m =>
    m.addEventListener("click", () => {
      $("cr-side").classList.add("cr-so");
      const card = $(`ac-${m.dataset.k}`);
      if (!card) return;
      card.scrollIntoView({behavior:"smooth",block:"center"});
      flashCard(card);
    })
  );

  // 长按段落 → 书签（移动端）
  let ptimer;
  el.querySelectorAll(".crp[data-p]").forEach(para => {
    para.addEventListener("touchstart",() => { ptimer=setTimeout(()=>bkToggle(+para.dataset.p),700); },{passive:true});
    para.addEventListener("touchend",  () => clearTimeout(ptimer),{passive:true});
    para.addEventListener("touchmove", () => clearTimeout(ptimer),{passive:true});
    // 双击 → TTS（桌面）
    para.addEventListener("dblclick",  () => {
      if (S().settings.ttsEnabled) ttsRead(para.textContent);
    });
  });

  renderList();
  updateStats();
  setTimeout(updateProgress, 100);
}

// ─────────────────────────────────────────────────────────────
//  书签
// ─────────────────────────────────────────────────────────────
function bkToggle(pIdx) {
  const book = curBook();
  if (!book) return;
  if (book.bookmarks[pIdx]) {
    delete book.bookmarks[pIdx]; toast("已移除书签");
  } else {
    book.bookmarks[pIdx] = true; toast("★ 已加书签");
    if (navigator.vibrate) navigator.vibrate(40);
  }
  save(); renderText();
}

// ─────────────────────────────────────────────────────────────
//  文字选中
// ─────────────────────────────────────────────────────────────
function onSelect() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const txt = sel.toString().trim();
  if (!txt || txt.length < 2 || txt.length > 500) return;
  const range = sel.getRangeAt(0);
  let node = range.startContainer;
  while (node && node.id !== "cr-c") {
    if (node.classList?.contains("crp") && node.dataset?.p !== undefined) break;
    node = node.parentElement;
  }
  if (!node || node.id === "cr-c") return;
  showPopup(+node.dataset.p, txt);
}

// ─────────────────────────────────────────────────────────────
//  批注输入弹窗
// ─────────────────────────────────────────────────────────────
function showPopup(pIdx, selTxt) {
  $("cr-pop")?.remove();
  const isShort = selTxt.length <= 30;
  const ttsBit  = S().settings.ttsEnabled
    ? `<button class="crb crb-sm cr-tts-btn" id="cr-ptts">🔊</button>` : "";

  const pop = document.createElement("div");
  pop.id = "cr-pop";
  pop.innerHTML = `
    <div class="pop-hd">
      <span>✏️ 「${trunc(selTxt,24)}」</span>
      <button class="crb crb-sm" id="cr-px">✕</button>
    </div>
    <textarea id="cr-pta" placeholder="写下批注（可留空，直接选择下方操作）" rows="3"></textarea>
    <div class="pop-ft">
      <button class="crb crb-sm crb-p"  id="cr-puser">💬 我来批注</button>
      <button class="crb crb-sm crb-ai" id="cr-pai">🤖 AI批注</button>
      ${isShort ? `<button class="crb crb-sm" id="cr-pexp">🔍 解释</button>
                   <button class="crb crb-sm" id="cr-ptr">🌐 翻译</button>` : ""}
      ${ttsBit}
      <button class="crb crb-sm" id="cr-pcan">取消</button>
    </div>
    <div id="cr-pop-res" style="display:none"></div>`;
  $("cr-cw").appendChild(pop);
  $("cr-pta").focus();

  const close = () => { pop.remove(); window.getSelection()?.removeAllRanges(); };
  $("cr-px").onclick = $("cr-pcan").onclick = close;

  $("cr-puser").onclick = async () => {
    const v = $("cr-pta").value.trim();
    if (!v) { $("cr-pta").focus(); return; }
    const k = addAnn(pIdx, selTxt, v, "user");
    close();
    if (S().settings.autoAiReply && k) await aiReply(k);
  };

  $("cr-pai").onclick = async () => {
    const hint = $("cr-pta").value.trim();
    close();
    await aiAnnotSel(pIdx, selTxt, hint);
  };

  if (isShort) {
    $("cr-pexp")?.addEventListener("click", () => doExplainTranslate(pop, pIdx, selTxt, "explain"));
    $("cr-ptr")?.addEventListener("click",  () => doExplainTranslate(pop, pIdx, selTxt, "translate"));
  }

  $("cr-ptts")?.addEventListener("click", () => ttsRead(selTxt));
}

// ─────────────────────────────────────────────────────────────
//  解释 & 翻译
// ─────────────────────────────────────────────────────────────
async function doExplainTranslate(pop, pIdx, selTxt, mode) {
  const resDiv = $("cr-pop-res");
  const btnId  = mode === "explain" ? "cr-pexp" : "cr-ptr";
  const btn    = $(btnId);
  resDiv.style.display = "block";
  resDiv.innerHTML = `<div class="cr-spin">⏳ 生成中…</div>`;
  if (btn) btn.disabled = true;

  const ch    = getCharInfo();
  const label = mode === "explain" ? "解释" : "翻译";
  const targetLang = S().settings.translateLang || "中文";

  const prompt = mode === "explain"
    ? `${ch?.sys || "你是一位博学的语文老师。"}

请详细解释以下词语/短语的含义、用法和可能的典故（100字以内，中文回答）：
「${selTxt}」`
    : `请直接将以下内容翻译成${targetLang}（只输出译文，不加任何解释）：
「${selTxt}」`;

  try {
    const result = (await callAI(prompt))?.trim() || "（无结果）";
    resDiv.innerHTML = `
      <div class="res-hd">${mode==="explain" ? "🔍 解释" : `🌐 翻译 → ${targetLang}`}</div>
      <div class="res-body">${esc(result)}</div>
      <div class="res-ft">
        <button class="crb crb-sm crb-p" id="cr-res-sv">📝 存为批注</button>
        <button class="crb crb-sm"       id="cr-res-cp">📋 复制</button>
      </div>`;

    $("cr-res-sv").onclick = () => {
      addAnn(pIdx, selTxt, `【${label}】${result}`, "user");
      pop.remove(); window.getSelection()?.removeAllRanges();
      toast("✓ 已保存为批注");
    };
    $("cr-res-cp").onclick = () => {
      navigator.clipboard?.writeText(result);
      toast("✓ 已复制");
    };
  } catch (err) {
    resDiv.innerHTML = `<div class="res-err">生成失败：${esc(err.message)}</div>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────
//  批注 CRUD
// ─────────────────────────────────────────────────────────────
function addAnn(pIdx, selectedText, text, origin) {
  const book = curBook();
  if (!book) return null;
  const key = `ann_${pIdx}_${Date.now()}`;
  book.annotations[key] = { key, pIdx, selectedText, text, origin, ts:Date.now(), thread:[], refs:[] };
  save(); renderText();
  return key;
}

function delAnn(key) {
  const book = curBook();
  if (!book || !confirm("确认删除这条批注？")) return;
  delete book.annotations[key];
  save(); renderText();
}

// ─────────────────────────────────────────────────────────────
//  批注列表渲染
// ─────────────────────────────────────────────────────────────
function renderList() {
  const list = $("cr-al");
  if (!list) return;
  const book = curBook();
  if (!book) { list.innerHTML=""; return; }

  const filter = $("cr-flt")?.value || "";
  const query  = ($("cr-si")?.value||"").trim().toLowerCase();
  let anns = Object.values(book.annotations);
  if (filter) anns = anns.filter(a => a.origin === filter);
  if (query)  anns = anns.filter(a =>
    a.text.toLowerCase().includes(query) ||
    a.selectedText.toLowerCase().includes(query) ||
    (a.thread||[]).some(r => r.text.toLowerCase().includes(query))
  );
  anns.sort((a,b) => a.pIdx - b.pIdx || a.ts - b.ts);

  if (!anns.length) {
    list.innerHTML = `<div class="cr-ae">${query?"无匹配批注":"选中正文文字即可添加批注"}</div>`;
    return;
  }
  list.innerHTML = anns.map(annCard).join("");

  list.querySelectorAll("[data-act]").forEach(btn =>
    btn.addEventListener("click", () => {
      const {act,key} = btn.dataset;
      if (act==="del")  delAnn(key);
      if (act==="send") userReply(key, btn.closest(".cr-ac"));
      if (act==="air")  aiReply(key);
      if (act==="link") showLinkPicker(key);
      if (act==="tts") {
        const body = btn.closest(".cr-ac")?.querySelector(".cr-ab")?.textContent||"";
        ttsActive ? ttsStop() : ttsRead(body);
      }
    })
  );

  list.querySelectorAll(".cr-ref").forEach(a =>
    a.addEventListener("click", e => {
      e.preventDefault();
      const t = $(`ac-${a.dataset.ref}`);
      if (!t) return;
      t.scrollIntoView({behavior:"smooth",block:"center"});
      flashCard(t);
    })
  );
}

function annCard(a) {
  const ico  = {user:"💬",ai:"🤖",auto:"✨"}[a.origin]||"💬";
  const lbl  = {user:"用户",ai:"AI选批",auto:"AI全文"}[a.origin]||"";
  const book = curBook();

  const refsHtml = (a.refs||[]).map(rk => {
    const ra = book?.annotations?.[rk];
    return ra ? `<a href="#" class="cr-ref" data-ref="${rk}">→ 「${trunc(ra.selectedText,12)}」</a>` : "";
  }).filter(Boolean).join("  ");

  const threadHtml = (a.thread||[]).map(r => `
    <div class="cr-tr cr-tr-${r.role}">
      <span class="cr-tl">${r.role==="ai"?"🤖":"💬"}</span>
      <div>${esc(r.text)}</div>
      <div class="cr-tm">${fmt(r.ts)}</div>
    </div>`).join("");

  const ttsBit = S().settings.ttsEnabled
    ? `<button class="crb crb-sm cr-tts-btn" data-act="tts" data-key="${a.key}">🔊</button>` : "";

  return `
    <div class="cr-ac" id="ac-${a.key}">
      <div class="cr-ac-hd">
        <span class="cr-ao">${ico} ${lbl}</span>
        <span class="cr-am">${fmt(a.ts)}</span>
      </div>
      <div class="cr-aq">「${trunc(a.selectedText,22)}」</div>
      <div class="cr-ab">${esc(a.text)}</div>
      ${refsHtml ? `<div class="cr-refs">${refsHtml}</div>` : ""}
      ${threadHtml}
      <div class="cr-af">
        <textarea class="cr-rta" placeholder="继续探讨…" rows="2"></textarea>
        <div class="cr-abtns">
          <button class="crb crb-sm"         data-act="send" data-key="${a.key}">💬</button>
          <button class="crb crb-sm crb-ai"  data-act="air"  data-key="${a.key}">🤖</button>
          <button class="crb crb-sm"         data-act="link" data-key="${a.key}" title="关联批注">🔗</button>
          ${ttsBit}
          <button class="crb crb-sm crb-del" data-act="del"  data-key="${a.key}">🗑</button>
        </div>
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────────
//  批注链接选择器
// ─────────────────────────────────────────────────────────────
function showLinkPicker(key) {
  const book = curBook();
  if (!book) return;
  $("cr-lm")?.remove();
  const others = Object.values(book.annotations).filter(a => a.key !== key);
  if (!others.length) { toast("暂无其他批注可关联"); return; }
  const cur = book.annotations[key]?.refs || [];
  const modal = document.createElement("div");
  modal.id = "cr-lm";
  modal.innerHTML = `
    <div id="cr-lm-box">
      <div class="cr-modal-hd">
        <span>🔗 关联批注</span>
        <button class="crb crb-sm" id="cr-lm-x">✕</button>
      </div>
      <div id="cr-lm-list">
        ${others.map(a => `
          <label class="lm-item">
            <input type="checkbox" value="${a.key}" ${cur.includes(a.key)?"checked":""}>
            <span class="lm-q">「${trunc(a.selectedText,16)}」</span>
            <span class="lm-t">${trunc(a.text,28)}</span>
          </label>`).join("")}
      </div>
      <div class="cr-modal-ft">
        <button class="crb crb-p" id="cr-lm-sv">保存</button>
        <button class="crb" id="cr-lm-cl">取消</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  $("cr-lm-x").onclick = $("cr-lm-cl").onclick = close;
  $("cr-lm-sv").onclick = () => {
    const checked = [...modal.querySelectorAll("input:checked")].map(c=>c.value);
    if (book.annotations[key]) { book.annotations[key].refs=checked; save(); renderList(); }
    toast(`✓ 关联 ${checked.length} 条`); close();
  };
}

// ─────────────────────────────────────────────────────────────
//  用户回复
// ─────────────────────────────────────────────────────────────
function userReply(key, card) {
  const book = curBook();
  const a = book?.annotations?.[key];
  if (!a) return;
  const ta  = card.querySelector(".cr-rta");
  const val = ta.value.trim();
  if (!val) return;
  a.thread.push({role:"user", text:val, ts:Date.now()});
  ta.value = "";
  save(); renderList();
  if (S().settings.autoAiReply) aiReply(key);
}

// ─────────────────────────────────────────────────────────────
//  AI 回复（含角色卡联动 + 对话历史）
// ─────────────────────────────────────────────────────────────
async function aiReply(key) {
  const book = curBook();
  const a = book?.annotations?.[key];
  if (!a) return;
  const btn = document.querySelector(`[data-act="air"][data-key="${key}"]`);
  if (btn) { btn.disabled=true; btn.textContent="⏳"; }

  const ch   = getCharInfo();
  const sys  = ch?.sys  || "你是一位博学细腻的共读伙伴。";
  const name = ch?.name || "AI";
  const hist = (a.thread||[]).map(r=>`${r.role==="ai"?name:"用户"}：${r.text}`).join("\n");

  const prompt = `${sys}

你和用户正在共读《${book.title}》，以下是围绕某段文字的批注对话。

【原文片段】「${a.selectedText}」
【批注】${a.text}
${hist?`【对话记录】\n${hist}`:""}

以"${name}"的口吻自然延续这段对话（共情、深析或追问，≤80字）：`;

  try {
    const reply = await callAI(prompt);
    if (reply) {
      a.thread.push({role:"ai", text:reply.trim(), ts:Date.now()});
      save(); renderList();
    }
  } catch (err) {
    toast("AI回复失败：" + err.message);
  } finally {
    if (btn) { btn.disabled=false; btn.textContent="🤖"; }
  }
}

// ─────────────────────────────────────────────────────────────
//  AI 批注选中片段
// ─────────────────────────────────────────────────────────────
async function aiAnnotSel(pIdx, selTxt, hint="") {
  const ch  = getCharInfo();
  const sys = ch?.sys || "你是一位博学细腻的共读伙伴。";
  const h   = hint ? `（用户提示：${hint}）` : "";
  const prompt = `${sys}

用户正在阅读《${curBook()?.title||"未知"}》，选中了以下片段，请以你的角色视角写批注${h}：

「${selTxt}」

给出 50-100 字的批注：`;
  toast("🤖 AI 正在批注…");
  try {
    const r = await callAI(prompt);
    if (r) { addAnn(pIdx, selTxt, r.trim(), "ai"); toast("✓ AI 批注完成"); }
  } catch { toast("AI 批注失败"); }
}

// ─────────────────────────────────────────────────────────────
//  全文自动批注
// ─────────────────────────────────────────────────────────────
async function autoAnnotate() {
  const book = curBook();
  if (!book) { toast("请先打开一本书"); return; }
  const btn = $("cr-autoann");
  btn.disabled=true; btn.innerHTML="⏳<span class='crl'> 批注中…</span>";

  const ch  = getCharInfo();
  const sys = ch?.sys || "你是一位博学细腻的共读伙伴。";
  const paras = book.text.split(/\r?\n/).map((t,i)=>({i,t:t.trim()})).filter(p=>p.t);

  const chunks = [];
  if (paras.length <= 8) {
    chunks.push(paras);
  } else {
    const sz=6, mid = Math.floor(paras.length/2)-Math.floor(sz/2);
    chunks.push(paras.slice(0,sz));
    chunks.push(paras.slice(Math.max(0,mid), mid+sz));
    chunks.push(paras.slice(Math.max(0,paras.length-sz)));
  }

  const toAdd = [];
  for (const chunk of chunks) {
    const txt = chunk.map(p=>`[${p.i}] ${p.t}`).join("\n");
    const prompt = `${sys}

请阅读下方《${book.title}》的文段，找出 2-4 处有价值片段进行批注。

输出格式（每条一行，用 ||| 分隔，禁止换行）：
段落行号|||原文片段(≤20字，必须是原文连续文字)|||批注(40-80字)

文段：
${txt}

只输出批注列表：`;

    try {
      const resp = await callAI(prompt);
      (resp||"").split("\n").forEach(line => {
        const pts = line.trim().split("|||");
        if (pts.length < 3) return;
        const hIdx = parseInt(pts[0].replace(/\D/g,""))||0;
        const sel  = pts[1].trim(), ann = pts[2].trim();
        if (!sel || sel.length < 2 || !ann) return;
        const realIdx = findPara(sel, hIdx);
        if (realIdx !== -1) toAdd.push({pIdx:realIdx, selectedText:sel, text:ann});
      });
    } catch (e) { console.error("[Co-Reader] autoAnnotate:", e); }
    await wait(600);
  }

  toAdd.forEach(({pIdx, selectedText, text}) => {
    const k = `ann_${pIdx}_${Date.now()}_${Math.random().toString(36).slice(2,5)}`;
    book.annotations[k] = {key:k, pIdx, selectedText, text, origin:"auto", ts:Date.now(), thread:[], refs:[]};
  });
  save(); renderText();
  btn.disabled=false; btn.innerHTML="🤖<span class='crl'> 全文批注</span>";
  toast(`✓ 生成 ${toAdd.length} 条批注`);
}

function findPara(text, hintIdx) {
  const book = curBook();
  if (!book) return -1;
  const ps = book.text.split(/\r?\n/);
  const cands = [hintIdx,hintIdx-1,hintIdx+1,hintIdx-2,hintIdx+2].filter(i=>i>=0&&i<ps.length);
  for (const i of cands) { if (ps[i]?.includes(text)) return i; }
  for (let i=0; i<ps.length; i++) { if (ps[i]?.includes(text)) return i; }
  return -1;
}

// ─────────────────────────────────────────────────────────────
//  统计栏
// ─────────────────────────────────────────────────────────────
function updateStats() {
  const el = $("cr-stats");
  if (!el) return;
  const book = curBook();
  if (!book) { el.textContent=""; return; }
  const anns = Object.values(book.annotations||{});
  const u = anns.filter(a=>a.origin==="user").length;
  const a = anns.filter(a=>a.origin==="ai").length;
  const o = anns.filter(a=>a.origin==="auto").length;
  const b = Object.keys(book.bookmarks||{}).length;
  el.innerHTML = `<span>共 <b>${anns.length}</b> 批注</span><span>💬${u}</span><span>🤖${a}</span><span>✨${o}</span><span>★${b} 书签</span>`;
}

// ─────────────────────────────────────────────────────────────
//  导出
// ─────────────────────────────────────────────────────────────
function exportJson() {
  const book = curBook();
  if (!book) { toast("请先打开一本书"); return; }
  dl(`${book.title}_批注.json`, JSON.stringify({
    version:"3.0", title:book.title, exportTime:new Date().toISOString(),
    annotations:book.annotations, bookmarks:book.bookmarks,
  },null,2), "application/json");
}

function exportTxt() {
  const book = curBook();
  if (!book) { toast("请先打开一本书"); return; }
  const ps = book.text.split(/\r?\n/);
  let out = `【共读：${book.title}】  ${new Date().toLocaleString()}\n${"─".repeat(44)}\n\n`;
  ps.forEach((p,i) => {
    if (book.bookmarks?.[i]) out += "★ ";
    out += p + "\n";
    Object.values(book.annotations||{}).filter(a=>a.pIdx===i).forEach(a => {
      const ic = {user:"💬",ai:"🤖",auto:"✨"}[a.origin]||"";
      out += `\n  [${ic}批注]「${a.selectedText}」\n    ${a.text}\n`;
      (a.thread||[]).forEach(r => {
        out += `    ${r.role==="ai"?"🤖：":"💬："}${r.text}\n`;
      });
      out += "\n";
    });
  });
  dl(`${book.title}_含批注.txt`, out, "text/plain;charset=utf-8");
}

function dl(name, content, type) {
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([content],{type})), download: name,
  });
  a.click(); URL.revokeObjectURL(a.href);
}

// ─────────────────────────────────────────────────────────────
//  AI 调用
// ─────────────────────────────────────────────────────────────
async function callAI(prompt) {
  const url = S().settings.customApiUrl;
  if (url) {
    const res = await fetch(url, {
      method:"POST",
      headers:{"Content-Type":"application/json",...getRequestHeaders()},
      body:JSON.stringify({messages:[{role:"user",content:prompt}],max_tokens:350,temperature:0.8}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    return d.choices?.[0]?.message?.content ?? d.response ?? "";
  }
  return await generateQuietPrompt(prompt, false, false);
}

// ─────────────────────────────────────────────────────────────
//  主题 & 设置
// ─────────────────────────────────────────────────────────────
function applyTheme() {
  const s = S().settings;
  const t = THEMES[s.themeName] || THEMES["深夜猫咖"];
  const r = document.documentElement;
  const set = (k,v) => r.style.setProperty(k,v);

  set("--cr-bg",   s.bgColor      || t.bgColor);
  set("--cr-tx",   s.textColor    || t.textColor);
  set("--cr-ac",   s.accentColor  || t.accentColor);
  set("--cr-pbg",  t.panelBg);
  set("--cr-sbg",  t.sideBg);
  set("--cr-br",   t.border);
  set("--cr-bbg",  t.btnBg);
  set("--cr-bhov", t.btnHov);
  set("--cr-ibg",  t.inputBg);
  set("--cr-cbg",  t.cardBg);
  set("--cr-mku",  t.mkU);
  set("--cr-mka",  t.mkA);
  set("--cr-mko",  t.mkO);
  set("--cr-fn",   s.font);
  set("--cr-fs",   s.fontSize);
  set("--cr-af",   s.annFont);
  set("--cr-as",   s.annFontSize);
  set("--cr-lh",   s.lineHeight);
}

function loadCfgForm() {
  document.querySelectorAll("#cr-cfg [data-k]").forEach(el => {
    const v = S().settings[el.dataset.k];
    if (el.type==="checkbox") el.checked = !!v;
    else if (el.type==="range") el.value = v??1;
    else if (v!==undefined) el.value = v;
  });
  refreshThemeBtns();
}

function refreshThemeBtns() {
  document.querySelectorAll(".cr-tbtn").forEach(btn =>
    btn.classList.toggle("crb-on", btn.dataset.t === S().settings.themeName)
  );
}

function saveCfg() {
  document.querySelectorAll("#cr-cfg [data-k]").forEach(el => {
    S().settings[el.dataset.k] = el.type==="checkbox" ? el.checked
      : el.type==="range" ? parseFloat(el.value) : el.value;
  });
  applyTheme(); save(); toggleCfg(false); toast("✓ 设置已保存");
}

function resetCfg() {
  S().settings = mkDef().settings;
  applyTheme(); save(); loadCfgForm(); toast("已恢复默认设置");
}

// ─────────────────────────────────────────────────────────────
//  工具函数
// ─────────────────────────────────────────────────────────────
const esc   = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const trunc = (s,n) => s.length>n ? s.slice(0,n)+"…" : s;
const fmt   = ts => new Date(ts).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});
const wait  = ms => new Promise(r => setTimeout(r,ms));

function flashCard(el) {
  el.classList.add("cr-flash");
  setTimeout(() => el.classList.remove("cr-flash"), 900);
}

function toast(msg, dur=2600) {
  $("cr-toast")?.remove();
  const el = Object.assign(document.createElement("div"), {id:"cr-toast",textContent:msg});
  document.body.appendChild(el);
  setTimeout(() => el?.remove(), dur);
}
