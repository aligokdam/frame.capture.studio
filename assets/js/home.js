/* =====================================================================
   Frame Capture Studio: home page and routing
   ---------------------------------------------------------------------
   Three routes in one document, so moving between them never reloads
   the page or loses the editor's state (video, cursor, frames):
     #/         home page (also any other hash, e.g. #features)
     #/editor   the editor
     #/terms    terms of use
   ===================================================================== */
(function () {
  "use strict";

  var root = document.documentElement;
  var Studio = window.FrameStudio;
  var home = document.getElementById("home");
  if (!home || !Studio) return;

  function routeFromHash() {
    if (/^#\/editor/.test(location.hash)) return "editor";
    if (/^#\/terms/.test(location.hash)) return "terms";
    return "home";
  }

  // A plain "#id" hash on the home route scrolls to that section.
  function sectionFromHash() {
    var m = /^#([a-z][\w-]*)$/i.exec(location.hash);
    var target = m && document.getElementById(m[1]);
    return target && home.contains(target) ? target : null;
  }

  function applyRoute(initial) {
    var next = routeFromHash();
    var prev = root.getAttribute("data-route");
    root.setAttribute("data-route", next);
    if (!initial && prev !== next) {
      Studio.closeSheet();
      var section = next === "home" && sectionFromHash();
      if (section) section.scrollIntoView();
      else window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      var heading = next === "editor" ? document.getElementById("editorTitle")
        : next === "terms" ? document.querySelector(".terms-title")
        : document.getElementById("heroTitle");
      if (heading) heading.focus({ preventScroll: true });
      if (next === "editor") requestAnimationFrame(Studio.relayout); // the timeline was hidden until now
    }
    }
  window.addEventListener("hashchange", function () { applyRoute(false); });

  document.getElementById("homeThemeBtn").addEventListener("click", function () { Studio.toggleTheme(); });
  document.getElementById("homeLangBtn").addEventListener("click", function () { Studio.openSheet("language"); });
  document.addEventListener("click", function (e) {
    // Privacy opens in the shared sheet, never as a separate page.
    if (e.target.closest("[data-open-privacy]")) { Studio.openSheet("privacy"); return; }
    // The logo always takes you to the top of the home page.
    var logo = e.target.closest("a.logo");
    if (logo && routeFromHash() === "home") {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: "smooth" });
      if (location.hash && location.hash !== "#/") history.replaceState(null, "", "#/");
    }
  });

  // Hairline under the navigation bar once the page has scrolled.
  var nav = document.getElementById("homeNav");
  function onScroll() { nav.classList.toggle("scrolled", window.scrollY > 4); }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Dropping a video anywhere on the home page opens it in the editor.
  home.addEventListener("dragover", function (e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    if (types && Array.prototype.indexOf.call(types, "Files") !== -1) e.preventDefault();
  });
  home.addEventListener("drop", function (e) {
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    location.hash = "#/editor";
    Studio.openFile(file);
  });

  applyRoute(true);
})();
