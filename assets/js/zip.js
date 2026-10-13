/* =====================================================================
   Frame Capture Studio: minimal ZIP writer
   ---------------------------------------------------------------------
   PNG and JPG are already compressed, so entries are stored as they are
   (method 0). The archive is assembled as a Blob from parts, which lets
   the browser keep large archives on disk instead of in one big buffer.
   No dependencies, nothing leaves the page.
   ===================================================================== */
(function () {
  "use strict";

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes, crc) {
    crc = (crc === undefined ? 0 : crc) ^ 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(date) {
    var time = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2));
    var day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time: time & 0xFFFF, date: day & 0xFFFF };
  }

  var encoder = new TextEncoder();

  /** Collects files and builds a stored (uncompressed) ZIP archive. */
  function ZipWriter() {
    this.parts = [];
    this.central = [];
    this.offset = 0;
    this.count = 0;
  }

  /** Approximate final size, used to split archives below the 4 GB ZIP limit. */
  ZipWriter.prototype.size = function () { return this.offset; };

  ZipWriter.prototype.add = function (name, blob, modified) {
    var self = this;
    return blob.arrayBuffer().then(function (buffer) {
      var data = new Uint8Array(buffer);
      var nameBytes = encoder.encode(name);
      var crc = crc32(data);
      var dt = dosDateTime(modified || new Date());

      var local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);            // version needed
      local.setUint16(6, 0x0800, true);        // UTF-8 names
      local.setUint16(8, 0, true);             // stored
      local.setUint16(10, dt.time, true);
      local.setUint16(12, dt.date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);

      var cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(10, 0, true);
      cen.setUint16(12, dt.time, true);
      cen.setUint16(14, dt.date, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, nameBytes.length, true);
      cen.setUint32(42, self.offset, true);

      self.parts.push(local.buffer, nameBytes, blob);
      self.central.push(cen.buffer, nameBytes);
      self.offset += 30 + nameBytes.length + data.length;
      self.count++;
    });
  };

  ZipWriter.prototype.finish = function () {
    var cdSize = 0;
    for (var i = 0; i < this.central.length; i++) cdSize += this.central[i].byteLength;
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.count, true);
    end.setUint16(10, this.count, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, this.offset, true);
    return new Blob(this.parts.concat(this.central, [end.buffer]), { type: "application/zip" });
  };

  window.FCSZip = Object.freeze({ ZipWriter: ZipWriter, crc32: crc32 });
})();
