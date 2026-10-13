/* =====================================================================
   Frame Capture Studio: frame grabber
   ---------------------------------------------------------------------
   A second, off-screen <video> that reads the same file as the preview.
   Seeking it never disturbs what the user is watching. Every request
   goes through one queue, so thumbnails and exports never race for the
   same element.

   Frames are drawn at the video's own pixel size (videoWidth x
   videoHeight), so exports are always full resolution.
   ===================================================================== */
(function () {
  "use strict";

  var SEEK_TIMEOUT = 10000;

  function Grabber() {
    var v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.setAttribute("aria-hidden", "true");
    // Kept in the document (not display:none) so browsers keep decoding
    // frames for it and requestVideoFrameCallback fires after a seek.
    v.style.cssText = "position:fixed;left:-10px;top:-10px;width:2px;height:2px;opacity:0;pointer-events:none;";
    document.body.appendChild(v);
    this.video = v;
    this.canvas = document.createElement("canvas");
    this.thumbCanvas = document.createElement("canvas");
    this.queue = Promise.resolve();
    this.src = null;
  }

  /** Points the grabber at a new source and resolves once metadata is in. */
  Grabber.prototype.load = function (src) {
    var v = this.video;
    this.src = src;
    this.queue = Promise.resolve();
    return new Promise(function (resolve, reject) {
      var done = function (ok, err) {
        v.removeEventListener("loadeddata", onReady);
        v.removeEventListener("error", onError);
        ok ? resolve() : reject(err);
      };
      var onReady = function () { done(true); };
      var onError = function () { done(false, new Error("decode")); };
      v.addEventListener("loadeddata", onReady);
      v.addEventListener("error", onError);
      v.src = src;
      v.load();
    });
  };

  Grabber.prototype.unload = function () {
    this.src = null;
    this.video.removeAttribute("src");
    this.video.load();
  };

  /* Runs fn after everything queued before it, even if that failed. */
  Grabber.prototype.enqueue = function (fn) {
    var next = this.queue.then(fn, fn);
    this.queue = next.catch(function () {});
    return next;
  };

  function seek(v, time) {
    return new Promise(function (resolve, reject) {
      var settled = false, timer;
      function finish(err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        v.removeEventListener("seeked", onSeeked);
        err ? reject(err) : resolve();
      }
      function onSeeked() {
        // Wait until the decoded frame for this position is actually
        // presented; fall back to a short delay where that API is missing.
        if (typeof v.requestVideoFrameCallback === "function") {
          v.requestVideoFrameCallback(function () { finish(); });
          setTimeout(function () { finish(); }, 300);
        } else {
          setTimeout(function () { finish(); }, 60);
        }
      }
      timer = setTimeout(function () { finish(new Error("seek-timeout")); }, SEEK_TIMEOUT);
      v.addEventListener("seeked", onSeeked);
      if (Math.abs(v.currentTime - time) < 0.0005 && v.readyState >= 2) {
        // Already there: nudge so a fresh "seeked" event still arrives.
        v.currentTime = Math.max(0, time - 0.0001);
      } else {
        v.currentTime = time;
      }
    });
  }

  function toBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error("encode")); }, type, quality);
    });
  }

  /**
   * Captures one full-resolution frame.
   * opts: { type: "image/png" | "image/jpeg", quality: 0..1, thumbEdge: px }
   * Resolves { time, blob, width, height, thumb } where thumb is an object URL.
   */
  Grabber.prototype.capture = function (time, opts) {
    var self = this;
    return this.enqueue(function () {
      var v = self.video;
      return seek(v, time).then(function () {
        var w = v.videoWidth, h = v.videoHeight;
        if (!w || !h) throw new Error("no-frame");
        var c = self.canvas;
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        var ctx = c.getContext("2d", { alpha: false });
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(v, 0, 0, w, h);

        var edge = opts.thumbEdge || 320;
        var s = Math.min(1, edge / Math.max(w, h));
        var tc = self.thumbCanvas;
        tc.width = Math.max(1, Math.round(w * s));
        tc.height = Math.max(1, Math.round(h * s));
        var tctx = tc.getContext("2d", { alpha: false });
        tctx.imageSmoothingQuality = "high";
        tctx.drawImage(c, 0, 0, tc.width, tc.height);

        return Promise.all([
          toBlob(c, opts.type, opts.type === "image/jpeg" ? opts.quality : undefined),
          toBlob(tc, "image/jpeg", 0.82),
        ]).then(function (blobs) {
          return { time: v.currentTime, blob: blobs[0], width: w, height: h, thumb: URL.createObjectURL(blobs[1]) };
        });
      });
    });
  };

  /** Small JPEG thumbnails for the filmstrip. onEach(index, url) fires as each one is ready. */
  Grabber.prototype.thumbnails = function (times, height, isStale, onEach) {
    var self = this;
    return this.enqueue(function () {
      var v = self.video;
      var out = [];
      var c = document.createElement("canvas");
      var i = 0;
      function step() {
        if (i >= times.length || (isStale && isStale())) return Promise.resolve(out);
        return seek(v, times[i]).then(function () {
          var w = v.videoWidth, h = v.videoHeight;
          c.height = height;
          c.width = Math.max(1, Math.round(height * w / h));
          c.getContext("2d", { alpha: false }).drawImage(v, 0, 0, c.width, c.height);
          return toBlob(c, "image/jpeg", 0.7);
        }).then(function (b) {
          var url = URL.createObjectURL(b);
          out.push(url);
          if (onEach) onEach(i, url);
          i++;
          return step();
        });
      }
      return step();
    });
  };

  window.FCSGrabber = Grabber;
})();
