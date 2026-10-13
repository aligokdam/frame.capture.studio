/* =====================================================================
   Frame Capture Studio: application
   ---------------------------------------------------------------------
   State flows one way:
     controls / cursor -> state -> plan (list of times) -> timeline marks
   Extraction walks the plan on an off-screen video (grabber.js), so the
   preview is never disturbed, and every frame is drawn at the video's
   native size before it is encoded as PNG or JPG.
   ===================================================================== */
(function () {
  "use strict";

  var VERSION = "1.0.0";
  var ASSET_QS = (function () {
    var src = document.currentScript && document.currentScript.src || "";
    var i = src.indexOf("?");
    return i === -1 ? "" : src.slice(i);
  })();

  /* Single source of truth for every reset. Change defaults here only. */
  var DEFAULT_SETTINGS = Object.freeze({
    start: "beginning",   // "beginning" | "cursor"
    interval: 1,          // seconds between frames, 1..5
    range: "manual",      // "manual" | "end"
    count: 3,             // frames in manual mode, 1..5
  });
  var LIMITS = Object.freeze({ intervalMin: 1, intervalMax: 5, countMin: 1, countMax: 5, maxFrames: 1000 });

  var DEFAULT_PREFERENCES = Object.freeze({
    exportFormat: "png",
  });
  var JPG_QUALITY = 0.95;

  var VIDEO_EXTENSIONS = [".mp4", ".m4v", ".mov", ".webm", ".mkv", ".ogv", ".ogg", ".avi", ".3gp"];
  var FRAME_STEP = 1 / 30;             // arrow-key step; browsers do not expose the real frame rate
  var END_MARGIN = 0.04;               // the very last instant often has no decodable frame
  var ZIP_PART_BYTES = 3.5 * 1024 * 1024 * 1024; // stay well below the 4 GB ZIP32 limit
  var THUMB_HEIGHT = 56;
  var STORAGE = { theme: "preferredTheme", lang: "preferredLanguage", prefs: "frameCaptureStudio.preferences", settings: "frameCaptureStudio.settings" };

  /* ----------------------------------------------------------- helpers */
  var $ = function (id) { return document.getElementById(id); };
  var root = document.documentElement;
  function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } }
  function load(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function pad(n, w) { n = String(n); while (n.length < w) n = "0" + n; return n; }

  /** 75.25 -> "01:15.25"; adds hours when the video is that long. */
  function formatTime(sec, withHours) {
    sec = Math.max(0, sec || 0);
    var cs = Math.floor(sec * 100 + 1e-6);
    var h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60, c = cs % 100;
    var core = pad(m, 2) + ":" + pad(s, 2) + "." + pad(c, 2);
    return (withHours || h > 0) ? pad(h, 2) + ":" + core : core;
  }
  /** File-name safe timestamp, e.g. 00-01-15-250 (h-m-s-ms). */
  function fileTime(sec) {
    var ms = Math.round(Math.max(0, sec) * 1000);
    return pad(Math.floor(ms / 3600000), 2) + "-" + pad(Math.floor(ms / 60000) % 60, 2) + "-" +
      pad(Math.floor(ms / 1000) % 60, 2) + "-" + pad(ms % 1000, 3);
  }
  function formatBytes(n) {
    if (n < 1024) return n + " B";
    var u = ["KB", "MB", "GB"], i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + " " + u[i];
  }

  function loadPreferences() {
    var prefs = Object.assign({}, DEFAULT_PREFERENCES);
    try {
      var saved = JSON.parse(load(STORAGE.prefs) || "{}");
      if (saved.exportFormat === "png" || saved.exportFormat === "jpg") prefs.exportFormat = saved.exportFormat;
    } catch (e) { /* ignore corrupt data */ }
    return prefs;
  }
  function normalizeSettings(s) {
    return {
      start: s.start === "cursor" ? "cursor" : "beginning",
      interval: clamp(Math.round(Number(s.interval) || DEFAULT_SETTINGS.interval), LIMITS.intervalMin, LIMITS.intervalMax),
      range: s.range === "end" ? "end" : "manual",
      count: clamp(Math.round(Number(s.count) || DEFAULT_SETTINGS.count), LIMITS.countMin, LIMITS.countMax),
    };
  }
  function loadSettings() {
    try { return normalizeSettings(Object.assign({}, DEFAULT_SETTINGS, JSON.parse(load(STORAGE.settings) || "{}"))); }
    catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
  }

  /* ------------------------------------------------------------- state */
  var state = {
    settings: loadSettings(),
    prefs: loadPreferences(),
    themePref: "dark",
    lang: "en",
    video: null,        // { name, base, url, size, duration, width, height }
    cursor: 0,          // seconds; the playhead the user drags
    frames: [],         // { id, time, blob, thumb, width, height, ext }
    seq: 0,
    job: null,          // running extraction: { cancelled, done, total }
    exporting: false,
    scrubbing: false,
  };

  var dom = {
    stageBody: $("stageBody"), dropzone: $("dropzone"), player: $("player"), video: $("video"), fileInput: $("fileInput"),
    playerTime: $("playerTime"), flash: $("flash"),
    fileMeta: $("fileMeta"), replaceBtn: $("replaceBtn"),
    transport: $("transport"), playBtn: $("playBtn"), stepBackBtn: $("stepBackBtn"), stepFwdBtn: $("stepFwdBtn"),
    tcNow: $("tcNow"), tcDur: $("tcDur"), snapBtn: $("snapBtn"),
    timeline: $("timeline"), filmstrip: $("filmstrip"), tlSkip: $("tlSkip"), tlTicks: $("tlTicks"), playhead: $("playhead"),
    startSeg: $("startSeg"), startValue: $("startValue"),
    interval: $("interval"), intervalValue: $("intervalValue"),
    rangeSeg: $("rangeSeg"), countControl: $("countControl"), count: $("count"), countValue: $("countValue"),
    planFrames: $("planFrames"), planSpan: $("planSpan"), planSize: $("planSize"),
    formatSeg: $("formatSeg"),
    extractBtn: $("extractBtn"), extractLabel: $("extractLabel"),
    progress: $("progress"), progressFill: $("progressFill"), progressText: $("progressText"), cancelBtn: $("cancelBtn"),
    results: $("results"), resultsMeta: $("resultsMeta"), frames: $("frames"),
    clearBtn: $("clearBtn"), folderBtn: $("folderBtn"), zipBtn: $("zipBtn"),
    busy: $("busy"), busyText: $("busyText"), toast: $("toast"), toastText: $("toastText"),
    themeBtn: $("themeBtn"), helpBtn: $("helpBtn"), langBtn: $("langBtn"),
    sheet: $("sheet"), sheetBackdrop: $("sheetBackdrop"), sheetTitle: $("sheetTitle"), sheetBack: $("sheetBack"),
    sheetBackLabel: $("sheetBackLabel"), sheetDone: $("sheetDone"), sheetBody: $("sheetBody"), langList: $("langList"),
  };
  var grabber = new window.FCSGrabber();
  var hasFolderPicker = typeof window.showDirectoryPicker === "function";

  /* ============================================================== i18n */
  var LANGUAGES = window.FCS_LANGUAGES || [];
  var DICT = window.FCS_TRANSLATIONS = window.FCS_TRANSLATIONS || {};
  function hasLanguage(code) { return LANGUAGES.some(function (l) { return l.code === code; }); }

  var langLoads = {};
  function loadLanguage(code) {
    if (DICT[code]) return Promise.resolve(true);
    if (!langLoads[code]) {
      langLoads[code] = new Promise(function (resolve) {
        var s = document.createElement("script");
        s.src = "assets/i18n/" + code + ".js" + ASSET_QS;
        s.onload = function () { resolve(!!DICT[code]); };
        s.onerror = function () { delete langLoads[code]; resolve(false); };
        document.head.appendChild(s);
      });
    }
    return langLoads[code];
  }

  /** t("extractN", { n: 4 }) -> "Extract 4 frames" */
  function t(key, vars) {
    var d = DICT[state.lang];
    var s = (d && d[key] != null) ? d[key] : (DICT.en && DICT.en[key] != null) ? DICT.en[key] : key;
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; });
    return s;
  }

  function detectLanguage() {
    var saved = load(STORAGE.lang);
    if (saved && hasLanguage(saved)) return saved;
    var prefs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"];
    for (var i = 0; i < prefs.length; i++) {
      var base = String(prefs[i] || "").toLowerCase().split("-")[0];
      if (base === "tl") base = "fil";
      if (hasLanguage(base)) return base;
    }
    return "en";
  }

  function applyTranslations() {
    document.querySelectorAll("[data-i18n]").forEach(function (el) { el.textContent = t(el.getAttribute("data-i18n")); });
    document.querySelectorAll("[data-i18n-aria]").forEach(function (el) { el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria"))); });
    document.querySelectorAll("[data-i18n-aria-label]").forEach(function (el) { el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria-label"))); });
    document.querySelectorAll("[data-i18n-title]").forEach(function (el) { el.setAttribute("title", t(el.getAttribute("data-i18n-title"))); });
    // Text with one inline link, written as "before [[link text]] after".
    document.querySelectorAll("[data-i18n-rich]").forEach(function (el) {
      var parts = t(el.getAttribute("data-i18n-rich")).split(/\[\[|\]\]/);
      var target = el.getAttribute("data-link");
      el.textContent = "";
      parts.forEach(function (part, i) {
        if (i % 2 === 0) { if (part) el.appendChild(document.createTextNode(part)); return; }
        var link;
        if (target === "privacy") {
          link = document.createElement("button");
          link.type = "button";
          link.className = "inline-link";
          link.setAttribute("data-open-privacy", "");
        } else {
          link = document.createElement("a");
          link.href = target;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        }
        link.textContent = part;
        el.appendChild(link);
      });
    });
    updateThemeButton();
    updateSheetChrome();
    refreshBusyText();
    syncControls();
    updatePlayButton();
    renderResultsMeta();
    dom.frames.querySelectorAll("[data-act=download]").forEach(function (b) { b.setAttribute("aria-label", t("downloadFrame")); b.title = t("downloadFrame"); });
    dom.frames.querySelectorAll("[data-act=remove]").forEach(function (b) { b.setAttribute("aria-label", t("removeFrame")); b.title = t("removeFrame"); });
  }

  var langRequest = 0;
  function setLanguage(code, persist) {
    if (!hasLanguage(code)) code = "en";
    var request = ++langRequest;
    return loadLanguage(code).then(function (ok) {
      if (request !== langRequest) return;
      if (!ok) return code === "en" ? null : setLanguage("en", persist);
      state.lang = code;
      var lang = LANGUAGES.find(function (l) { return l.code === code; });
      root.setAttribute("lang", code);
      root.setAttribute("dir", lang && lang.rtl ? "rtl" : "ltr");
      if (persist) store(STORAGE.lang, code);
      renderLanguageList();
      applyTranslations();
      root.classList.remove("i18n-wait");
      document.dispatchEvent(new CustomEvent("fcs:languagechange", { detail: { lang: code } }));
    });
  }

  function renderLanguageList() {
    var list = dom.langList;
    if (!list.childElementCount) {
      LANGUAGES.forEach(function (lang) {
        var li = document.createElement("li");
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "row";
        btn.setAttribute("role", "radio");
        btn.setAttribute("data-lang", lang.code);
        var main = document.createElement("span");
        main.className = "row-main";
        var name = document.createElement("span");
        name.className = "row-label";
        name.setAttribute("lang", lang.code);
        name.setAttribute("dir", lang.rtl ? "rtl" : "ltr");
        name.textContent = lang.name;
        main.appendChild(name);
        btn.appendChild(main);
        btn.insertAdjacentHTML("beforeend", '<svg class="check" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 9.5l3.5 3.5 7.5-8"/></svg>');
        btn.addEventListener("click", function () { setLanguage(lang.code, true); });
        li.appendChild(btn);
        list.appendChild(li);
      });
    }
    list.querySelectorAll("[data-lang]").forEach(function (btn) {
      btn.setAttribute("aria-checked", String(btn.getAttribute("data-lang") === state.lang));
    });
  }

  /* ============================================================= theme */
  var lightQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
  function resolveTheme(pref) { return pref === "system" ? (lightQuery && lightQuery.matches ? "light" : "dark") : pref; }

  function updateThemeButton() {
    var label = t(root.getAttribute("data-theme") === "dark" ? "themeToLight" : "themeToDark");
    [dom.themeBtn, $("homeThemeBtn")].forEach(function (b) {
      if (!b) return;
      b.setAttribute("aria-label", label);
      b.setAttribute("title", label);
    });
  }

  function setThemePreference(pref, animate) {
    if (pref !== "dark" && pref !== "light" && pref !== "system") pref = "dark";
    state.themePref = pref;
    store(STORAGE.theme, pref);
    var theme = resolveTheme(pref);
    if (root.getAttribute("data-theme") === theme) { updateThemeButton(); return; }
    var apply = function () {
      root.setAttribute("data-theme", theme);
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", theme === "light" ? "#f5f5f7" : "#0a0a0b");
      updateThemeButton();
      drawTicks();
    };
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduce) { apply(); return; }
    if (typeof document.startViewTransition === "function") {
      try { document.startViewTransition(apply); return; } catch (e) { /* fall through */ }
    }
    root.classList.add("theme-switching");
    apply();
    setTimeout(function () { root.classList.remove("theme-switching"); }, 450);
  }

  /* ======================================================== controls UI */
  function setSegmented(group, attr, value) {
    if (!group) return;
    group.querySelectorAll("[" + attr + "]").forEach(function (b) {
      var on = b.getAttribute(attr) === value;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }

  function bindSegmented(group, attr, onSelect) {
    var buttons = Array.prototype.slice.call(group.querySelectorAll("[" + attr + "]"));
    buttons.forEach(function (b, i) {
      b.addEventListener("click", function () { if (!b.disabled) onSelect(b.getAttribute(attr)); });
      b.addEventListener("keydown", function (e) {
        var dir = 0;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") dir = 1;
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") dir = -1;
        if (!dir) return;
        if (root.getAttribute("dir") === "rtl" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) dir = -dir;
        e.preventDefault();
        var next = buttons[(i + dir + buttons.length) % buttons.length];
        if (next.disabled) return;
        next.focus();
        onSelect(next.getAttribute(attr));
      });
    });
  }

  function paintRange(input) {
    var min = Number(input.min), max = Number(input.max), v = Number(input.value);
    input.style.setProperty("--p", ((v - min) / (max - min)) * 100 + "%");
  }

  function syncControls() {
    var s = state.settings;
    setSegmented(dom.startSeg, "data-start", s.start);
    setSegmented(dom.rangeSeg, "data-range", s.range);
    dom.interval.value = String(s.interval);
    dom.interval.setAttribute("aria-valuetext", t("secondsShort", { n: s.interval }));
    dom.intervalValue.textContent = t("secondsShort", { n: s.interval });
    $("intervalMin").textContent = t("secondsShort", { n: LIMITS.intervalMin });
    $("intervalMax").textContent = t("secondsShort", { n: LIMITS.intervalMax });
    dom.count.value = String(s.count);
    dom.countValue.textContent = String(s.count);
    dom.countControl.hidden = s.range !== "manual";
    paintRange(dom.interval);
    paintRange(dom.count);

    setSegmented(dom.formatSeg, "data-format", state.prefs.exportFormat);

    var locked = !!state.job;
    [dom.interval, dom.count].forEach(function (el) { el.disabled = locked; });
    [dom.startSeg, dom.rangeSeg, dom.formatSeg].forEach(function (g) {
      g.querySelectorAll("button").forEach(function (b) { b.disabled = locked; });
    });
    renderPlan();
  }

  function updateSettings(partial) {
    state.settings = normalizeSettings(Object.assign({}, state.settings, partial));
    store(STORAGE.settings, JSON.stringify(state.settings));
    syncControls();
  }

  function setPreference(key, value) {
    state.prefs[key] = value;
    store(STORAGE.prefs, JSON.stringify(state.prefs));
    syncControls();
  }

  /* =========================================================== toasts */
  var toastTimer = null;
  function toast(message, tone) {
    dom.toastText.textContent = message;
    dom.toast.setAttribute("data-tone", tone || "info");
    dom.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { dom.toast.classList.remove("show"); }, tone === "error" ? 6000 : 2600);
  }

  /* ============================================================= busy */
  var busy = { key: null, vars: null, timer: null };
  function refreshBusyText() { dom.busyText.textContent = t(busy.key || "working", busy.vars); }
  function setBusy(key, vars) {
    busy.key = key; busy.vars = vars || null;
    refreshBusyText();
    clearTimeout(busy.timer);
    if (key) busy.timer = setTimeout(function () { dom.busy.classList.add("show"); }, 140);
    else dom.busy.classList.remove("show");
    root.toggleAttribute("data-busy", !!key);
  }

  /* ============================================================== plan
     The list of times that will be captured. Computed from the settings,
     the cursor and the duration; drawn as marks on the timeline. */
  function lastTime() { return state.video ? Math.max(0, state.video.duration - END_MARGIN) : 0; }
  function startTime() { return state.settings.start === "cursor" ? Math.min(state.cursor, lastTime()) : 0; }

  function computePlan() {
    if (!state.video) return { times: [], truncated: false };
    var s = state.settings, start = startTime(), end = lastTime();
    var wanted = s.range === "manual" ? s.count : Infinity;
    var times = [];
    for (var i = 0; times.length < wanted; i++) {
      var time = start + i * s.interval;
      if (time > end + 1e-6) break;
      if (times.length >= LIMITS.maxFrames) return { times: times, truncated: true };
      times.push(Math.round(time * 1000) / 1000);
    }
    return { times: times, truncated: false };
  }

  function renderPlan() {
    var plan = computePlan();
    var n = plan.times.length;
    var v = state.video;
    var hours = v && v.duration >= 3600;
    dom.startValue.textContent = formatTime(startTime(), hours);
    if (!v) {
      dom.planFrames.textContent = dom.planSpan.textContent = dom.planSize.textContent = "–";
    } else {
      dom.planFrames.textContent = plan.truncated ? t("planLimit", { n: n }) : String(n);
      dom.planSpan.textContent = n ? formatTime(plan.times[0], hours) + " → " + formatTime(plan.times[n - 1], hours) : "–";
      dom.planSize.textContent = v.width + " × " + v.height + " · " + state.prefs.exportFormat.toUpperCase();
    }
    dom.extractLabel.textContent = !v || !n ? t("extractNone") : n === 1 ? t("extractOne") : t("extractN", { n: n });
    dom.extractBtn.disabled = !v || !n || !!state.job;
    renderTimelineMarks(plan.times);
  }

  /* ========================================================== timeline */
  function pct(time) { return state.video && state.video.duration ? clamp(time / state.video.duration, 0, 1) * 100 : 0; }

  var ticksCanvas = document.createElement("canvas");
  dom.tlTicks.appendChild(ticksCanvas);
  var lastTicks = [];

  function renderTimelineMarks(times) {
    lastTicks = times;
    var start = startTime();
    dom.tlSkip.style.width = pct(start) + "%";
    drawTicks();
  }

  function drawTicks() {
    var w = dom.tlTicks.clientWidth, h = dom.tlTicks.clientHeight;
    if (!w || !h) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    if (ticksCanvas.width !== Math.round(w * dpr) || ticksCanvas.height !== Math.round(h * dpr)) {
      ticksCanvas.width = Math.round(w * dpr);
      ticksCanvas.height = Math.round(h * dpr);
    }
    var ctx = ticksCanvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!state.video || !lastTicks.length) return;
    var color = getComputedStyle(root).getPropertyValue("--tick").trim() || "#ffd60a";
    ctx.fillStyle = color;
    var dense = lastTicks.length > w / 4;
    var prevX = -10;
    lastTicks.forEach(function (time) {
      var x = Math.round(time / state.video.duration * w);
      if (dense && x - prevX < 2) return;   // keep very dense plans readable
      prevX = x;
      var tx = Math.min(w - 2, Math.max(0, x - 1));
      ctx.fillStyle = "rgba(0,0,0,.55)";
      ctx.fillRect(tx - 1, 0, 4, h);
      ctx.fillStyle = color;
      ctx.fillRect(tx, 0, 2, h);
      ctx.beginPath();
      ctx.arc(clamp(x, 3, w - 3), h - 4, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function renderCursor() {
    var v = state.video;
    var p = pct(state.cursor);
    dom.playhead.style.left = p + "%";
    var hours = v && v.duration >= 3600;
    var label = formatTime(state.cursor, hours);
    dom.tcNow.textContent = label;
    dom.playerTime.textContent = label;
    dom.playhead.setAttribute("aria-valuenow", String(Math.round(state.cursor * 100) / 100));
    dom.playhead.setAttribute("aria-valuetext", label);
    if (state.settings.start === "cursor") renderPlan();
  }

  /** Moves the cursor (and the preview) to a time. */
  function setCursor(time, opts) {
    if (!state.video) return;
    state.cursor = clamp(time, 0, lastTime());
    if (!opts || opts.seek !== false) {
      var v = dom.video;
      if (opts && opts.fast && typeof v.fastSeek === "function") v.fastSeek(state.cursor);
      else v.currentTime = state.cursor;
    }
    renderCursor();
  }

  /* Filmstrip: small frames along the timeline, made by the grabber. */
  var stripGen = 0;
  function buildFilmstrip() {
    var gen = ++stripGen;
    dom.filmstrip.textContent = "";
    if (!state.video) return;
    var w = dom.filmstrip.clientWidth;
    if (!w) return;
    var cellW = THUMB_HEIGHT * state.video.width / state.video.height;
    var n = clamp(Math.ceil(w / cellW), 1, 40);
    var times = [];
    for (var i = 0; i < n; i++) times.push(Math.min(lastTime(), (i + 0.5) * state.video.duration / n));
    var cells = times.map(function () {
      var img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      dom.filmstrip.appendChild(img);
      return img;
    });
    dom.filmstrip.setAttribute("data-count", String(n));
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    grabber.thumbnails(times, Math.round(THUMB_HEIGHT * dpr), function () { return gen !== stripGen; }, function (i, url) {
      if (gen !== stripGen) { URL.revokeObjectURL(url); return; }
      cells[i].onload = function () { cells[i].classList.add("in"); };
      cells[i].src = url;
    }).catch(function () { /* thumbnails are optional */ });
  }
  var stripWidth = 0, stripTimer = null;
  function onTimelineResize() {
    drawTicks();
    var w = dom.filmstrip.clientWidth;
    if (!state.video || Math.abs(w - stripWidth) < 24) return;
    stripWidth = w;
    clearTimeout(stripTimer);
    stripTimer = setTimeout(buildFilmstrip, 220);
  }

  function bindTimeline() {
    var tl = dom.timeline;
    var wasPlaying = false;
    function timeAt(e) {
      var r = tl.getBoundingClientRect();
      return clamp((e.clientX - r.left) / r.width, 0, 1) * (state.video ? state.video.duration : 0);
    }
    tl.addEventListener("pointerdown", function (e) {
      if (!state.video || e.button > 0) return;
      e.preventDefault();
      wasPlaying = !dom.video.paused;
      if (wasPlaying) dom.video.pause();
      state.scrubbing = true;
      tl.classList.add("scrubbing");
      tl.setPointerCapture(e.pointerId);
      dom.playhead.focus({ preventScroll: true });
      setCursor(timeAt(e), { fast: true });
    });
    tl.addEventListener("pointermove", function (e) {
      if (!state.scrubbing) return;
      setCursor(timeAt(e), { fast: true });
    });
    function end(e) {
      if (!state.scrubbing) return;
      state.scrubbing = false;
      tl.classList.remove("scrubbing");
      setCursor(timeAt(e)); // exact seek on release
      if (wasPlaying) dom.video.play().catch(function () {});
    }
    tl.addEventListener("pointerup", end);
    tl.addEventListener("pointercancel", end);

    dom.playhead.addEventListener("keydown", function (e) {
      if (!state.video) return;
      var big = Math.max(1, state.video.duration / 10);
      var map = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1 };
      if (map[e.key]) {
        e.preventDefault(); e.stopPropagation();
        step(map[e.key] * (e.shiftKey ? 1 : FRAME_STEP));
      } else if (e.key === "PageUp" || e.key === "PageDown") {
        e.preventDefault(); e.stopPropagation();
        setCursor(state.cursor + (e.key === "PageUp" ? big : -big));
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault(); e.stopPropagation();
        setCursor(e.key === "Home" ? 0 : lastTime());
      }
    });
  }

  function step(delta) {
    if (!state.video) return;
    if (!dom.video.paused) dom.video.pause();
    setCursor(state.cursor + delta);
  }

  /* ============================================================ player */
  function updatePlayButton() {
    var playing = state.video && !dom.video.paused;
    dom.playBtn.querySelector("use").setAttribute("href", playing ? "#i-pause" : "#i-play");
    var label = t(playing ? "pause" : "play");
    dom.playBtn.setAttribute("aria-label", label);
    dom.playBtn.title = label;
  }

  function togglePlay() {
    if (!state.video) return;
    var v = dom.video;
    if (v.paused) {
      if (state.cursor >= lastTime() - 0.01) setCursor(0);
      v.play().catch(function () {});
    } else {
      v.pause();
    }
  }

  var rafId = 0;
  function followPlayback() {
    cancelAnimationFrame(rafId);
    var tick = function () {
      if (dom.video.paused || state.scrubbing) return;
      state.cursor = clamp(dom.video.currentTime, 0, lastTime());
      renderCursor();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function layoutPlayer() {
    if (!state.video) return;
    dom.player.style.setProperty("--ar", String(state.video.width / state.video.height));
  }

  /* ======================================================= open a file */
  function extensionOf(name) {
    var i = String(name || "").lastIndexOf(".");
    return i === -1 ? "" : name.slice(i).toLowerCase();
  }
  function isVideoFile(file) {
    return /^video\//.test(file.type || "") || VIDEO_EXTENSIONS.indexOf(extensionOf(file.name)) !== -1;
  }

  /* Some WebM/MKV files report an infinite duration until the end is probed. */
  function resolveDuration(v) {
    if (isFinite(v.duration) && v.duration > 0) return Promise.resolve(v.duration);
    return new Promise(function (resolve) {
      var done = function () {
        if (!isFinite(v.duration)) return;
        v.removeEventListener("durationchange", done);
        v.currentTime = 0;
        resolve(v.duration);
      };
      v.addEventListener("durationchange", done);
      v.currentTime = 1e7;
      setTimeout(function () { v.removeEventListener("durationchange", done); resolve(isFinite(v.duration) ? v.duration : 0); }, 5000);
    });
  }

  var openRequest = 0;
  function openFile(file) {
    if (!file) { toast(t("errorNoFile"), "error"); return Promise.resolve(false); }
    if (!isVideoFile(file)) { toast(t("errorType"), "error"); return Promise.resolve(false); }
    if (state.job) cancelExtraction();
    var request = ++openRequest;
    var url = URL.createObjectURL(file);
    var v = dom.video;
    setBusy("opening");

    var metadata = new Promise(function (resolve, reject) {
      var ok = function () { cleanup(); resolve(); };
      var bad = function () { cleanup(); reject(new Error("decode")); };
      function cleanup() { v.removeEventListener("loadeddata", ok); v.removeEventListener("error", bad); }
      v.addEventListener("loadeddata", ok);
      v.addEventListener("error", bad);
    });
    v.pause();
    v.src = url;
    v.load();

    return metadata
      .then(function () { return resolveDuration(v); })
      .then(function (duration) {
        if (request !== openRequest) return false;
        if (!v.videoWidth || !v.videoHeight || !duration) throw new Error("decode");
        return grabber.load(url).then(function () {
          if (request !== openRequest) return false;
          var old = state.video;
          if (old) URL.revokeObjectURL(old.url);
          var base = file.name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "") || "video";
          state.video = { name: file.name, base: base, url: url, size: file.size, duration: duration, width: v.videoWidth, height: v.videoHeight };
          state.cursor = 0;
          v.currentTime = 0;
          dom.dropzone.hidden = true;
          dom.player.hidden = false;
          dom.transport.hidden = false;
          dom.replaceBtn.hidden = false;
          dom.stageBody.classList.add("has-video");
          dom.fileMeta.textContent = file.name + " · " + v.videoWidth + " × " + v.videoHeight + " · " + formatTime(duration);
          dom.fileMeta.title = file.name;
          dom.tcDur.textContent = formatTime(duration, duration >= 3600);
          dom.playhead.setAttribute("aria-valuemax", String(Math.round(duration * 100) / 100));
          layoutPlayer();
          setBusy(null);
          stripWidth = 0;
          requestAnimationFrame(function () { renderCursor(); syncControls(); onTimelineResize(); });
          return true;
        });
      })
      .catch(function () {
        if (request !== openRequest) return false;
        URL.revokeObjectURL(url);
        setBusy(null);
        if (state.video) { v.src = state.video.url; v.currentTime = state.cursor; }
        else { v.removeAttribute("src"); v.load(); }
        toast(t("errorDecode"), "error");
        return false;
      });
  }

  /* ========================================================= capturing */
  function captureOptions() {
    var jpg = state.prefs.exportFormat === "jpg";
    return { type: jpg ? "image/jpeg" : "image/png", quality: JPG_QUALITY, thumbEdge: 360, ext: jpg ? "jpg" : "png" };
  }

  function flash() {
    dom.flash.classList.remove("go");
    void dom.flash.offsetWidth;
    dom.flash.classList.add("go");
  }

  function addFrame(shot, ext) {
    var frame = { id: ++state.seq, time: shot.time, blob: shot.blob, thumb: shot.thumb, width: shot.width, height: shot.height, ext: ext, base: state.video.base };
    state.frames.push(frame);
    dom.results.hidden = false;
    dom.frames.appendChild(frameItem(frame));
    renderResultsMeta();
    return frame;
  }

  function frameName(frame) {
    return frame.base + "_" + pad(frame.id, 4) + "_" + fileTime(frame.time) + "." + frame.ext;
  }

  function frameItem(frame) {
    var li = document.createElement("li");
    li.className = "frame-item";
    li.setAttribute("data-id", String(frame.id));
    var hours = state.video && state.video.duration >= 3600;
    li.innerHTML =
      '<div class="frame-thumb"><img alt="" decoding="async"><span class="frame-no"></span></div>' +
      '<div class="frame-info"><span class="frame-time"></span><span class="frame-size"></span></div>' +
      '<div class="frame-actions">' +
        '<button class="icon-btn small" type="button" data-act="download"><svg aria-hidden="true"><use href="#i-download"/></svg></button>' +
        '<button class="icon-btn small" type="button" data-act="remove"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg></button>' +
      "</div>";
    var img = li.querySelector("img");
    img.src = frame.thumb;
    img.style.aspectRatio = frame.width + " / " + frame.height;
    img.alt = formatTime(frame.time, hours);
    li.querySelector(".frame-no").textContent = "#" + frame.id;
    li.querySelector(".frame-time").textContent = formatTime(frame.time, hours);
    li.querySelector(".frame-size").textContent = frame.ext.toUpperCase() + " · " + formatBytes(frame.blob.size);
    li.querySelectorAll("[data-act]").forEach(function (b) {
      var key = b.getAttribute("data-act") === "download" ? "downloadFrame" : "removeFrame";
      b.setAttribute("aria-label", t(key));
      b.title = t(key);
    });
    return li;
  }

  function renderResultsMeta() {
    var total = state.frames.reduce(function (sum, f) { return sum + f.blob.size; }, 0);
    dom.resultsMeta.textContent = t("resultsMeta", { n: state.frames.length, size: formatBytes(total) });
    var empty = !state.frames.length;
    dom.zipBtn.disabled = empty || state.exporting;
    dom.folderBtn.disabled = empty || state.exporting;
    dom.clearBtn.disabled = empty || state.exporting || !!state.job;
    dom.folderBtn.hidden = !hasFolderPicker;
    if (empty) dom.results.hidden = true;
  }

  function snapFrame() {
    if (!state.video || state.job) return Promise.resolve(null);
    if (!dom.video.paused) dom.video.pause();
    var opts = captureOptions();
    var time = state.cursor;
    flash();
    return grabber.capture(time, opts).then(function (shot) {
      var frame = addFrame(shot, opts.ext);
      toast(t("toastSnapped", { t: formatTime(frame.time) }));
      return frame;
    }).catch(function () {
      toast(t("errorCapture", { t: formatTime(time) }), "error");
      return null;
    });
  }

  function setProgress(done, total) {
    dom.progressFill.style.width = (total ? done / total * 100 : 0) + "%";
    dom.progressText.textContent = t("progressText", { done: done, total: total });
  }

  function extract() {
    if (!state.video || state.job) return Promise.resolve(0);
    var plan = computePlan();
    if (!plan.times.length) return Promise.resolve(0);
    if (!dom.video.paused) dom.video.pause();
    var opts = captureOptions();
    var job = { cancelled: false, done: 0, total: plan.times.length, failed: 0 };
    state.job = job;
    dom.progress.hidden = false;
    dom.extractBtn.hidden = true;
    setProgress(0, job.total);
    syncControls();
    renderResultsMeta();
    var firstNew = null;

    var i = 0;
    function next() {
      if (job.cancelled || i >= plan.times.length) return Promise.resolve();
      var time = plan.times[i++];
      return grabber.capture(time, opts).then(function (shot) {
        if (job.cancelled) { URL.revokeObjectURL(shot.thumb); return; }
        var f = addFrame(shot, opts.ext);
        if (!firstNew) firstNew = f;
        job.done++;
      }, function () {
        job.failed++;
        if (job.failed === 1) toast(t("errorCapture", { t: formatTime(time) }), "error");
      }).then(function () {
        setProgress(job.done + job.failed, job.total);
        return next();
      });
    }

    return next().then(function () {
      state.job = null;
      dom.progress.hidden = true;
      dom.extractBtn.hidden = false;
      syncControls();
      renderResultsMeta();
      if (job.cancelled) toast(t("toastCancelled", { n: job.done }));
      else if (!job.failed) toast(job.done === 1 ? t("toastExtractedOne") : t("toastExtracted", { n: job.done }));
      if (firstNew) {
        var el = dom.frames.querySelector('[data-id="' + firstNew.id + '"]');
        if (el && el.getBoundingClientRect().top > window.innerHeight) el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return job.done;
    });
  }

  function cancelExtraction() { if (state.job) state.job.cancelled = true; }

  /* ============================================================ export */
  function download(blob, name) {
    var a = document.createElement("a");
    var url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  function frameById(id) { return state.frames.find(function (f) { return f.id === id; }); }

  function removeFrame(id) {
    var f = frameById(id);
    if (!f) return;
    URL.revokeObjectURL(f.thumb);
    state.frames = state.frames.filter(function (x) { return x !== f; });
    var el = dom.frames.querySelector('[data-id="' + id + '"]');
    if (el) el.remove();
    renderResultsMeta();
  }

  function clearFrames() {
    state.frames.forEach(function (f) { URL.revokeObjectURL(f.thumb); });
    state.frames = [];
    state.seq = 0;
    dom.frames.textContent = "";
    renderResultsMeta();
    toast(t("toastCleared"));
  }

  function exportZip() {
    if (!state.frames.length || state.exporting) return Promise.resolve();
    state.exporting = true;
    renderResultsMeta();
    var frames = state.frames.slice().sort(function (a, b) { return a.time - b.time || a.id - b.id; });
    var base = frames[0].base;
    var zips = [], zip = new window.FCSZip.ZipWriter(), i = 0;
    setBusy("zipping", { p: 0 });
    function next() {
      if (i >= frames.length) return Promise.resolve();
      var f = frames[i++];
      if (zip.count && zip.size() + f.blob.size > ZIP_PART_BYTES) { zips.push(zip); zip = new window.FCSZip.ZipWriter(); }
      return zip.add(frameName(f), f.blob).then(function () {
        setBusy("zipping", { p: Math.round(i / frames.length * 100) });
        return next();
      });
    }
    return next().then(function () {
      zips.push(zip);
      zips.forEach(function (z, k) {
        var name = base + "_frames" + (zips.length > 1 ? "_part" + (k + 1) : "") + ".zip";
        setTimeout(function () { download(z.finish(), name); }, k * 600);
      });
      if (zips.length > 1) toast(t("toastZipSplit", { n: zips.length }));
    }).finally(function () {
      state.exporting = false;
      setBusy(null);
      renderResultsMeta();
    });
  }

  function saveToFolder() {
    if (!state.frames.length || state.exporting || !hasFolderPicker) return Promise.resolve();
    var frames = state.frames.slice().sort(function (a, b) { return a.time - b.time || a.id - b.id; });
    return window.showDirectoryPicker({ mode: "readwrite", id: "frame-capture", startIn: "pictures" }).then(function (dir) {
      state.exporting = true;
      renderResultsMeta();
      var i = 0;
      setBusy("saving", { done: 0, total: frames.length });
      function next() {
        if (i >= frames.length) return Promise.resolve();
        var f = frames[i++];
        return dir.getFileHandle(frameName(f), { create: true })
          .then(function (h) { return h.createWritable(); })
          .then(function (w) { return w.write(f.blob).then(function () { return w.close(); }); })
          .then(function () { setBusy("saving", { done: i, total: frames.length }); return next(); });
      }
      return next().then(function () {
        toast(t("toastSaved", { n: frames.length }));
      }, function () {
        toast(t("errorFolder"), "error");
      }).finally(function () {
        state.exporting = false;
        setBusy(null);
        renderResultsMeta();
      });
    }, function (err) {
      if (err && err.name !== "AbortError") toast(t("errorFolder"), "error");
    });
  }

  /* ============================================================= sheet */
  var TITLES = { language: "langLabel", privacy: "privacyTitle", guide: "guideTitle" };
  var sheet = { stack: [], opener: null };
  function pages() { return Array.prototype.slice.call(document.querySelectorAll("[data-page]")); }

  function updateSheetChrome() {
    var top = sheet.stack[sheet.stack.length - 1];
    dom.sheetTitle.textContent = top ? t(TITLES[top]) : "";
    dom.sheetBack.hidden = sheet.stack.length < 2;
    dom.sheetBackLabel.textContent = t("back");
    dom.sheetBack.setAttribute("aria-label", t("back"));
  }

  function showView(name, direction) {
    dom.sheetBody.querySelectorAll(".view").forEach(function (v) {
      var on = v.getAttribute("data-view") === name;
      v.hidden = !on;
      v.classList.remove("enter", "enter-back");
      if (on && direction) { void v.offsetWidth; v.classList.add(direction === "back" ? "enter-back" : "enter"); }
    });
    dom.sheetBody.scrollTop = 0;
    if (name === "language") renderLanguageList();
    updateSheetChrome();
  }

  function openSheet(view) {
    if (!sheet.stack.length) sheet.opener = document.activeElement;
    sheet.stack = [view];
    showView(view, null);
    dom.sheet.classList.add("open");
    dom.sheetBackdrop.classList.add("open");
    dom.sheet.setAttribute("aria-hidden", "false");
    pages().forEach(function (el) { el.inert = true; el.setAttribute("aria-hidden", "true"); });
    root.style.overflow = "hidden";
    setTimeout(function () {
      dom.sheet.focus({ preventScroll: true });
      if (view === "language") {
        var current = dom.langList.querySelector('[aria-checked="true"]');
        if (current) current.scrollIntoView({ block: "center" });
      }
    }, 30);
  }
  function pushView(view) { sheet.stack.push(view); showView(view, "forward"); dom.sheet.focus({ preventScroll: true }); }
  function popView() {
    if (sheet.stack.length < 2) return;
    sheet.stack.pop();
    showView(sheet.stack[sheet.stack.length - 1], "back");
  }
  function closeSheet() {
    if (!sheet.stack.length) return;
    sheet.stack = [];
    dom.sheet.classList.remove("open");
    dom.sheetBackdrop.classList.remove("open");
    dom.sheet.setAttribute("aria-hidden", "true");
    pages().forEach(function (el) { el.inert = false; el.removeAttribute("aria-hidden"); });
    root.style.overflow = "";
    var back = sheet.opener;
    sheet.opener = null;
    if (back && typeof back.focus === "function") back.focus({ preventScroll: true });
  }
  function trapFocus(e) {
    if (e.key !== "Tab" || !sheet.stack.length) return;
    var focusables = Array.prototype.filter.call(
      dom.sheet.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      function (el) { return el.offsetParent !== null; }
    );
    if (!focusables.length) return;
    var first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ============================================================ events */
  function bindEvents() {
    var pick = function () { dom.fileInput.click(); };
    dom.dropzone.addEventListener("click", pick);
    dom.dropzone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); }
    });
    dom.replaceBtn.addEventListener("click", pick);
    dom.fileInput.addEventListener("change", function () {
      var file = dom.fileInput.files && dom.fileInput.files[0];
      if (file) openFile(file);
      dom.fileInput.value = "";
    });

    // Drag and drop onto the whole stage (also replaces a loaded video).
    var depth = 0;
    var hasFiles = function (e) {
      var types = e.dataTransfer && e.dataTransfer.types;
      return !!types && Array.prototype.indexOf.call(types, "Files") !== -1;
    };
    dom.stageBody.addEventListener("dragenter", function (e) { if (!hasFiles(e)) return; e.preventDefault(); depth++; dom.stageBody.classList.add("dragging"); });
    dom.stageBody.addEventListener("dragover", function (e) { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    dom.stageBody.addEventListener("dragleave", function () { depth = Math.max(0, depth - 1); if (!depth) dom.stageBody.classList.remove("dragging"); });
    dom.stageBody.addEventListener("drop", function (e) {
      e.preventDefault(); depth = 0; dom.stageBody.classList.remove("dragging");
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) openFile(file); else toast(t("errorNoFile"), "error");
    });
    window.addEventListener("dragover", function (e) { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener("drop", function (e) { if (hasFiles(e)) e.preventDefault(); });

    // Player.
    var v = dom.video;
    v.addEventListener("play", function () { updatePlayButton(); followPlayback(); });
    v.addEventListener("pause", function () { updatePlayButton(); state.cursor = clamp(v.currentTime, 0, lastTime()); renderCursor(); });
    v.addEventListener("ended", function () { updatePlayButton(); setCursor(lastTime(), { seek: false }); });
    dom.player.addEventListener("click", togglePlay);
    dom.playBtn.addEventListener("click", togglePlay);
    dom.stepBackBtn.addEventListener("click", function () { step(-FRAME_STEP); });
    dom.stepFwdBtn.addEventListener("click", function () { step(FRAME_STEP); });
    dom.snapBtn.addEventListener("click", snapFrame);
    bindTimeline();

    // Settings.
    bindSegmented(dom.startSeg, "data-start", function (val) { updateSettings({ start: val }); });
    bindSegmented(dom.rangeSeg, "data-range", function (val) { updateSettings({ range: val }); });
    dom.interval.addEventListener("input", function () { updateSettings({ interval: Number(dom.interval.value) }); });
    dom.count.addEventListener("input", function () { updateSettings({ count: Number(dom.count.value) }); });
    bindSegmented(dom.formatSeg, "data-format", function (val) { setPreference("exportFormat", val); });

    // Extraction and export.
    dom.extractBtn.addEventListener("click", extract);
    dom.cancelBtn.addEventListener("click", cancelExtraction);
    dom.zipBtn.addEventListener("click", exportZip);
    dom.folderBtn.addEventListener("click", saveToFolder);
    dom.clearBtn.addEventListener("click", clearFrames);
    dom.frames.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-act]");
      var item = e.target.closest(".frame-item");
      if (!item) return;
      var f = frameById(Number(item.getAttribute("data-id")));
      if (!f) return;
      if (btn && btn.getAttribute("data-act") === "remove") { removeFrame(f.id); return; }
      if (btn && btn.getAttribute("data-act") === "download") { download(f.blob, frameName(f)); return; }
      if (e.target.closest(".frame-thumb") && state.video && f.base === state.video.base) setCursor(f.time);
    });

    // Toolbar.
    dom.themeBtn.addEventListener("click", function () { setThemePreference(root.getAttribute("data-theme") === "dark" ? "light" : "dark", true); });
    dom.helpBtn.addEventListener("click", function () { openSheet("guide"); });
    dom.langBtn.addEventListener("click", function () { openSheet("language"); });

    // Sheet navigation.
    dom.sheetDone.addEventListener("click", closeSheet);
    dom.sheetBackdrop.addEventListener("click", closeSheet);
    dom.sheetBack.addEventListener("click", popView);
    dom.sheetBody.addEventListener("click", function (e) {
      var push = e.target.closest("[data-push]");
      if (push) pushView(push.getAttribute("data-push"));
    });

    document.addEventListener("keydown", function (e) {
      if (sheet.stack.length) {
        if (e.key === "Escape") { e.preventDefault(); closeSheet(); return; }
        trapFocus(e);
        return;
      }
      if (root.getAttribute("data-route") !== "editor" || !state.video || e.metaKey || e.ctrlKey || e.altKey) return;
      var tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " " && !(e.target.closest && e.target.closest("button, [role=radio], a"))) { e.preventDefault(); togglePlay(); }
      else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !(e.target.closest && e.target.closest("[role=radiogroup]"))) {
        e.preventDefault();
        step((e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 1 : FRAME_STEP));
      } else if (e.key === "s" || e.key === "S") { e.preventDefault(); snapFrame(); }
    });

    if (lightQuery) {
      var onScheme = function () { if (state.themePref === "system") setThemePreference("system", true); };
      lightQuery.addEventListener ? lightQuery.addEventListener("change", onScheme) : lightQuery.addListener(onScheme);
    }
    if (window.ResizeObserver) new ResizeObserver(onTimelineResize).observe(dom.timeline);
    window.addEventListener("resize", onTimelineResize);
    window.addEventListener("beforeunload", function (e) {
      if (state.frames.length || state.job) { e.preventDefault(); e.returnValue = ""; }
    });
  }

  /* ============================================================== boot */
  function init() {
    var savedTheme = load(STORAGE.theme);
    state.themePref = savedTheme === "light" || savedTheme === "system" || savedTheme === "dark" ? savedTheme : "dark";
    setThemePreference(state.themePref, false);
    bindEvents();
    syncControls();
    renderResultsMeta();
    setLanguage(detectLanguage(), false).then(function () { root.setAttribute("data-ready", "true"); });
  }

  // Small, stable surface for the home page, automated tests and debugging.
  window.FrameStudio = Object.freeze({
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    LIMITS: LIMITS,
    version: VERSION,
    getState: function () {
      return {
        settings: Object.assign({}, state.settings),
        prefs: Object.assign({}, state.prefs),
        cursor: state.cursor,
        plan: computePlan().times,
        video: state.video ? { name: state.video.name, duration: state.video.duration, width: state.video.width, height: state.video.height } : null,
        frames: state.frames.map(function (f) { return { id: f.id, time: f.time, width: f.width, height: f.height, ext: f.ext, bytes: f.blob.size, name: frameName(f) }; }),
        running: !!state.job,
        lang: state.lang, theme: root.getAttribute("data-theme"),
      };
    },
    openFile: openFile,
    setCursor: function (time) { setCursor(time); },
    updateSettings: updateSettings,
    setPreference: setPreference,
    extract: extract,
    snap: snapFrame,
    buildZip: function () {
      var frames = state.frames.slice().sort(function (a, b) { return a.time - b.time; });
      var zip = new window.FCSZip.ZipWriter();
      return frames.reduce(function (p, f) { return p.then(function () { return zip.add(frameName(f), f.blob); }); }, Promise.resolve())
        .then(function () { return zip.finish(); });
    },
    t: t,
    openSheet: openSheet,
    closeSheet: closeSheet,
    toggleTheme: function () { setThemePreference(root.getAttribute("data-theme") === "dark" ? "light" : "dark", true); },
    relayout: onTimelineResize,
  });

  init();
})();
