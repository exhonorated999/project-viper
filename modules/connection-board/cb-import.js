/* ============================================================
   Connection Board: third-party data in.
     - Spreadsheets (CSV / TSV / XLSX, or rows pasted from Excel) with a
       column mapper
     - Map files (KML / KMZ / GeoJSON)
     - Paste cards: a screenshot or text, with source + capture time
     - "Send to board" from the resource tray (opens the card modal)
   Imported rows become pins with sourceType 'import:<batchId>' so a batch
   can be removed as a unit; batch metadata lives in cbImports_<caseId>.
   Every overlay here is fixed + appended to <body> so it sits above the
   board drawer and the resource tray.
   Depends on: ConnectionBoard (hooks), CBImportParse, FlockXlsx (xlsx/kmz).
   ============================================================ */
(function () {
  'use strict';

  var MAX_ROWS = 5000, WARN_ROWS = 1000;
  var FIELD_LABELS = {
    label: 'Name / label', address: 'Address', latlng: 'Lat,Lng (one column)', lat: 'Latitude', lng: 'Longitude',
    datetime: 'Date & time', date: 'Date', time: 'Time', type: 'Pin type', plate: 'Plate', phone: 'Phone', notes: 'Notes'
  };
  var FIELD_ORDER = ['label', 'address', 'latlng', 'lat', 'lng', 'datetime', 'date', 'time', 'type', 'plate', 'phone', 'notes'];

  function CB() { return window.ConnectionBoard; }
  function P() { return window.CBImportParse; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function toast(m, t) { try { (window.viperToast || window.showToast || function () {})(m, t || 'info'); } catch (_) {} }
  function curCase() { return (typeof currentCase !== 'undefined' && currentCase) ? currentCase : null; }
  function boardOpen() { return !!(CB() && CB().isOpen && CB().isOpen()); }
  function isEditable(el) {
    if (!el || el === document.body) return false;
    var t = (el.tagName || '').toLowerCase();
    return t === 'input' || t === 'textarea' || t === 'select' || !!el.isContentEditable;
  }
  function colName(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  function nowLocalInput() { var d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
  function stamp() { var d = new Date(); function p(n) { return (n < 10 ? '0' : '') + n; } return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
  function fmtDur(sec) { return sec < 90 ? '~' + Math.max(1, Math.round(sec)) + 's' : '~' + Math.round(sec / 60) + ' min'; }
  function typeOptions(sel, exclude) {
    var meta = (CB() && CB().typeMeta) ? CB().typeMeta() : {};
    return P().TYPES.filter(function (t) { return meta[t] && (!exclude || exclude.indexOf(t) < 0); }).map(function (t) {
      return '<option value="' + t + '"' + (t === sel ? ' selected' : '') + '>' + esc(meta[t].label) + '</option>';
    }).join('');
  }

  // ── batch metadata ───────────────────────────────────────────
  function batchKey() { var c = curCase(); return c ? 'cbImports_' + c.id : null; }
  function loadBatches() { var k = batchKey(); if (!k) return []; try { var a = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
  function saveBatches(a) { var k = batchKey(); if (k) try { localStorage.setItem(k, JSON.stringify(a)); } catch (e) { console.warn('[CBImport] save batches', e); } }
  function updateBatch(id, patch) { var a = loadBatches(); a.forEach(function (b) { if (b.id === id) Object.keys(patch).forEach(function (k) { b[k] = patch[k]; }); }); saveBatches(a); }

  // ── overlay helper ───────────────────────────────────────────
  var openOverlays = 0;
  function overlay(html, cls, onClose) {
    var back = document.createElement('div');
    back.className = 'cbi-back';
    back.innerHTML = '<div class="cbi-modal ' + (cls || '') + '">' + html + '</div>';
    document.body.appendChild(back);
    openOverlays++;
    var closed = false;
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    }
    function close() {
      if (closed) return; closed = true; openOverlays--;
      window.removeEventListener('keydown', onKey, true);
      if (back.parentNode) back.parentNode.removeChild(back);
      if (onClose) try { onClose(); } catch (e) { console.warn(e); }
    }
    window.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', function (e) { if (e.target === back) back._downOnBack = true; });
    back.addEventListener('click', function (e) { if (e.target === back && back._downOnBack) close(); back._downOnBack = false; });
    return { back: back, box: back.firstChild, close: close, q: function (s) { return back.querySelector(s); } };
  }

  // ── file reading ─────────────────────────────────────────────
  function pickFile(accept) {
    return new Promise(function (resolve) {
      var inp = document.createElement('input');
      inp.type = 'file'; inp.accept = accept; inp.style.display = 'none';
      inp.addEventListener('change', function () { resolve(inp.files && inp.files[0] ? inp.files[0] : null); inp.remove(); });
      document.body.appendChild(inp);
      inp.click();
    });
  }
  function readText(file) { return file.text ? file.text() : new Response(file).text(); }

  /** Route any dropped / picked file to the right importer. */
  function handleFile(file) {
    if (!file) return;
    if (!curCase()) { toast('Open a case first', 'warning'); return; }
    if (/^image\//i.test(file.type)) { openCardModal({ image: file, kind: 'file', title: file.name.replace(/\.[^.]+$/, '') }); return; }
    var kind = P().fileKind(file.name);
    if (kind === 'xls') { toast('Old .xls workbooks are not supported: open it in Excel and save as .xlsx or .csv', 'warning'); return; }
    if (kind === 'delimited') {
      readText(file).then(function (txt) {
        var rows = P().parseDelimited(txt);
        openMapper({ name: file.name, kind: 'csv', sheets: [{ name: file.name, rows: rows }] });
      }).catch(function (e) { toast('Could not read ' + file.name + ': ' + (e.message || e), 'error'); });
      return;
    }
    if (kind === 'xlsx') {
      if (!window.FlockXlsx) { toast('Spreadsheet reader not loaded', 'error'); return; }
      file.arrayBuffer().then(function (buf) { return window.FlockXlsx.readWorkbook(buf); }).then(function (wb) {
        var sheets = (wb.sheets || []).filter(function (s) { return s.rows && s.rows.length; });
        if (!sheets.length) { toast(file.name + ' has no data', 'warning'); return; }
        openMapper({ name: file.name, kind: 'xlsx', sheets: sheets });
      }).catch(function (e) { toast('Could not read ' + file.name + ': ' + (e.message || e), 'error'); });
      return;
    }
    if (kind === 'kml') { readText(file).then(function (t) { openMapFile({ name: file.name, kind: 'kml', text: t }); }); return; }
    if (kind === 'geojson') { readText(file).then(function (t) { openMapFile({ name: file.name, kind: 'geojson', text: t }); }); return; }
    if (kind === 'kmz') {
      if (!window.FlockXlsx || !window.FlockXlsx.readZipText) { toast('KMZ reader not loaded', 'error'); return; }
      file.arrayBuffer().then(function (buf) { return window.FlockXlsx.readZipText(buf, function (n) { return /\.kml$/i.test(n); }); })
        .then(function (docs) {
          if (!docs || !docs.length) { toast('No KML found inside ' + file.name, 'warning'); return; }
          var main = docs.filter(function (d) { return /(^|\/)doc\.kml$/i.test(d.name); })[0] || docs[0];
          openMapFile({ name: file.name, kind: 'kmz', text: main.text });
        }).catch(function (e) { toast('Could not read ' + file.name + ': ' + (e.message || e), 'error'); });
      return;
    }
    toast('Unsupported file: ' + file.name + ' (use CSV, TSV, XLSX, KML, KMZ, GeoJSON or an image)', 'warning');
  }

  // ── import + geocode ─────────────────────────────────────────
  var geoQueue = Promise.resolve();
  var chipEl = null, geoStop = false;
  function showChip(text) {
    if (!chipEl) {
      chipEl = document.createElement('div');
      chipEl.className = 'cbi-chip';
      chipEl.innerHTML = '<span class="cbi-spin"></span><span class="cbi-chip-text"></span><button class="cb-btn cbi-chip-stop" title="Stop looking up addresses (you can resume from the Import menu)">Stop</button>';
      chipEl.querySelector('.cbi-chip-stop').addEventListener('click', function () { geoStop = true; chipEl.querySelector('.cbi-chip-text').textContent = 'Stopping\u2026'; });
      document.body.appendChild(chipEl);
    }
    chipEl.querySelector('.cbi-chip-text').textContent = text;
  }
  function hideChip() { if (chipEl && chipEl.parentNode) chipEl.parentNode.removeChild(chipEl); chipEl = null; }

  function runGeocode(batch) {
    geoQueue = geoQueue.then(function () {
      if (!CB() || !CB().geocodePending) return;
      geoStop = false;
      showChip('Looking up addresses for \u201C' + batch.name + '\u201D\u2026');
      return CB().geocodePending('import:' + batch.id, function (done, total, found) {
        showChip('Looking up addresses for \u201C' + batch.name + '\u201D: ' + done + '/' + total + ' \u00B7 ' + found + ' found');
        return !geoStop;
      }).then(function (r) {
        hideChip();
        if (!r || !r.total) { toast('No addresses left to look up in \u201C' + batch.name + '\u201D', 'info'); return; }
        var b = loadBatches().filter(function (x) { return x.id === batch.id; })[0];
        if (b) updateBatch(batch.id, { located: (b.located || 0) + r.found });
        if (r.found && !batch.located && CB().fitToSource) CB().fitToSource('import:' + batch.id);
        toast('Found ' + r.found + ' of ' + r.done + ' addresses for \u201C' + batch.name + '\u201D' + (r.stopped ? ' (stopped; resume from Import \u25B8 batches)' : ''), r.found ? 'success' : 'warning');
      });
    }).catch(function (e) { hideChip(); console.warn('[CBImport] geocode', e); });
    return geoQueue;
  }

  function commitImport(batch, specs) {
    if (!specs.length) { toast('Nothing to import', 'warning'); return; }
    var res = CB().addPins(specs);
    var all = loadBatches().filter(function (b) { return b.id !== batch.id; });
    all.push(batch);
    saveBatches(all);
    var msg = 'Imported ' + (res.added + res.updated) + ' pin' + (specs.length === 1 ? '' : 's') + ' from \u201C' + batch.name + '\u201D: ' + batch.located + ' on the map';
    if (batch.needGeocode) msg += ', ' + batch.needGeocode + ' address' + (batch.needGeocode === 1 ? '' : 'es') + ' to look up';
    toast(msg, 'success');
    if (batch.located && CB().fitToSource) CB().fitToSource('import:' + batch.id);
    if (batch.needGeocode) runGeocode(batch);
  }

  function previewTable(specs) {
    var meta = (CB() && CB().typeMeta) ? CB().typeMeta() : {};
    if (!specs.length) return '<div class="cbi-empty">No rows produce a pin with this mapping yet.</div>';
    return '<table class="cbi-table"><thead><tr><th>Label</th><th>Type</th><th>Where</th><th>When</th><th>Notes</th></tr></thead><tbody>' +
      specs.slice(0, 8).map(function (s) {
        var where = s.lat != null ? s.lat.toFixed(5) + ', ' + s.lng.toFixed(5) : (s.address ? '\uD83D\uDD0E ' + s.address : '<span class="cbi-dim">no location (list only)</span>');
        return '<tr><td>' + esc(s.label) + '</td><td>' + esc((meta[s.type] || {}).label || s.type) + '</td><td>' + (s.lat != null || s.address ? esc(where) : where) +
          '</td><td>' + esc((s.data && s.data.datetime) || '') + '</td><td class="cbi-notes">' + esc(((s.data && s.data.notes) || '').slice(0, 140)) + '</td></tr>';
      }).join('') + '</tbody></table>' +
      (specs.length > 8 ? '<div class="cbi-dim" style="margin-top:4px">\u2026 and ' + (specs.length - 8) + ' more</div>' : '');
  }

  // ── spreadsheet column mapper ────────────────────────────────
  function openMapper(src) {
    if (!P()) { toast('Import parser not loaded', 'error'); return; }
    var st = { sheet: 0, header: 0, mapping: null, type: 'location', extra: true, name: src.name.replace(/\.[^.]+$/, '') || src.name };
    function rows() { return src.sheets[st.sheet].rows || []; }
    function width() { return rows().reduce(function (m, r) { return Math.max(m, (r || []).length); }, 0); }
    function guess() { st.header = P().headerRowIndex(rows()); st.mapping = P().guessColumns(rows()[st.header] || []); }
    guess();

    var sheetSel = src.sheets.length > 1 ? '<label class="cbi-field" style="width:200px">Sheet<select class="cbi-input" data-k="sheet">' +
      src.sheets.map(function (s, i) { return '<option value="' + i + '">' + esc(s.name) + ' (' + s.rows.length + ' rows)</option>'; }).join('') + '</select></label>' : '';

    var o = overlay(
      '<div class="cbi-title">\u2B06 Import spreadsheet <span class="cbi-sub">' + esc(src.name) + '</span></div>' +
      '<div class="cbi-row">' + sheetSel +
        '<label class="cbi-field" style="width:110px">Header row<input class="cbi-input" type="number" min="1" data-k="header"></label>' +
        '<label class="cbi-field" style="width:170px">Default pin type<select class="cbi-input" data-k="type">' + typeOptions(st.type, ['case']) + '</select></label>' +
        '<label class="cbi-field" style="flex:1;min-width:200px">Batch name<input class="cbi-input" data-k="name" maxlength="80"></label>' +
      '</div>' +
      '<div class="cbi-h">Which column holds what? <span class="cbi-dim">(guessed from the headers; change any that are wrong)</span></div>' +
      '<div class="cbi-map-grid" data-host="map"></div>' +
      '<label class="cbi-check"><input type="checkbox" data-k="extra" checked> Keep the other columns in each card\u2019s notes</label>' +
      '<div class="cbi-summary" data-host="sum"></div>' +
      '<div data-host="prev"></div>' +
      '<div class="cbi-actions"><button class="cb-btn" data-act="cancel">Cancel</button><button class="cb-btn cb-modal-ok" data-act="ok">Import</button></div>',
      'cbi-wide');

    var lastRes = null;
    function renderMapGrid() {
      var hdr = rows()[st.header] || [];
      var opts = '<option value="-1">\u2014 not used \u2014</option>';
      for (var i = 0; i < width(); i++) opts += '<option value="' + i + '">' + colName(i) + (hdr[i] ? ' \u00B7 ' + esc(String(hdr[i]).slice(0, 40)) : '') + '</option>';
      o.q('[data-host="map"]').innerHTML = FIELD_ORDER.map(function (f) {
        return '<label class="cbi-field">' + FIELD_LABELS[f] + '<select class="cbi-input" data-field="' + f + '">' + opts + '</select></label>';
      }).join('');
      FIELD_ORDER.forEach(function (f) { o.q('[data-field="' + f + '"]').value = String(st.mapping[f] != null ? st.mapping[f] : -1); });
    }
    function recompute() {
      var all = rows();
      var dataRows = Math.max(0, all.length - st.header - 1);
      var capped = dataRows > MAX_ROWS;
      var use = capped ? all.slice(0, st.header + 1 + MAX_ROWS) : all;
      st.batchId = st.batchId || P().newBatchId();
      lastRes = P().rowsToSpecs(use, st.mapping, {
        batchId: st.batchId, sourceName: src.name + (src.sheets.length > 1 ? ' \u203A ' + src.sheets[st.sheet].name : ''),
        importedAt: new Date().toISOString(), defaultType: st.type, headerIndex: st.header, extraCols: st.extra
      });
      var noLoc = lastRes.specs.length - lastRes.located - lastRes.needGeocode;
      var html = '<b>' + dataRows + '</b> data row' + (dataRows === 1 ? '' : 's') + ' \u2192 <b>' + lastRes.specs.length + '</b> pins \u00B7 ' +
        '<span class="cbi-ok">' + lastRes.located + ' with coordinates</span> \u00B7 ' +
        '<span class="cbi-geo">' + lastRes.needGeocode + ' addresses to look up' + (lastRes.needGeocode ? ' (' + fmtDur(lastRes.needGeocode * 1.1) + ')' : '') + '</span>' +
        (noLoc > 0 ? ' \u00B7 <span class="cbi-dim">' + noLoc + ' list-only (no location)</span>' : '') +
        (lastRes.skipped.length ? ' \u00B7 <span class="cbi-dim">' + lastRes.skipped.length + ' skipped (blank name, address and coordinates)</span>' : '');
      if (capped) html += '<div class="cbi-warn">Only the first ' + MAX_ROWS + ' rows will be imported (the sheet has ' + dataRows + '). Split large exports into smaller files.</div>';
      else if (dataRows > WARN_ROWS) html += '<div class="cbi-warn">Large import: ' + dataRows + ' rows can make the map slow. Consider filtering the sheet first.</div>';
      if (lastRes.needGeocode > 300) html += '<div class="cbi-warn">' + lastRes.needGeocode + ' address lookups run at about one per second. You can stop and resume them later.</div>';
      if (st.mapping.label < 0 && st.mapping.address < 0 && st.mapping.latlng < 0 && st.mapping.lat < 0) html += '<div class="cbi-warn">Pick at least a name, address or coordinate column.</div>';
      o.q('[data-host="sum"]').innerHTML = html;
      o.q('[data-host="prev"]').innerHTML = previewTable(lastRes.specs);
      var ok = o.q('[data-act="ok"]');
      ok.textContent = 'Import ' + lastRes.specs.length + ' pin' + (lastRes.specs.length === 1 ? '' : 's');
      ok.disabled = !lastRes.specs.length;
    }
    function syncTop() {
      var h = o.q('[data-k="header"]'); h.value = st.header + 1; h.max = Math.min(rows().length, 50);
      o.q('[data-k="name"]').value = st.name;
    }
    syncTop(); renderMapGrid(); recompute();

    o.box.addEventListener('change', function (e) {
      var t = e.target, k = t.getAttribute('data-k'), f = t.getAttribute('data-field');
      if (f) {
        var v = parseInt(t.value, 10);
        // One column feeds one field: release it from any other field.
        if (v >= 0) FIELD_ORDER.forEach(function (g) { if (g !== f && st.mapping[g] === v) { st.mapping[g] = -1; o.q('[data-field="' + g + '"]').value = '-1'; } });
        st.mapping[f] = v;
      } else if (k === 'sheet') { st.sheet = parseInt(t.value, 10) || 0; guess(); syncTop(); renderMapGrid(); }
      else if (k === 'header') { st.header = Math.max(0, Math.min(rows().length - 1, (parseInt(t.value, 10) || 1) - 1)); st.mapping = P().guessColumns(rows()[st.header] || []); renderMapGrid(); }
      else if (k === 'type') st.type = t.value;
      else if (k === 'extra') st.extra = t.checked;
      else if (k === 'name') { st.name = t.value.trim() || st.name; return; }
      recompute();
    });
    o.box.addEventListener('click', function (e) {
      var a = e.target.closest('[data-act]'); if (!a) return;
      if (a.getAttribute('data-act') === 'cancel') { o.close(); return; }
      if (!lastRes || !lastRes.specs.length) return;
      st.name = o.q('[data-k="name"]').value.trim() || st.name;
      var batch = { id: st.batchId, name: st.name, kind: src.kind, file: src.name, importedAt: new Date().toISOString(),
        count: lastRes.specs.length, located: lastRes.located, needGeocode: lastRes.needGeocode };
      o.close();
      commitImport(batch, lastRes.specs);
    });
  }

  // ── KML / KMZ / GeoJSON ──────────────────────────────────────
  function openMapFile(src) {
    var st = { type: 'location', name: src.name.replace(/\.[^.]+$/, '') || src.name, batchId: P().newBatchId() };
    var parsed = null, err = '';
    function parse() {
      var opts = { batchId: st.batchId, sourceName: src.name, importedAt: new Date().toISOString(), defaultType: st.type };
      try { parsed = src.kind === 'geojson' ? P().parseGeoJson(src.text, opts) : P().parseKml(src.text, opts); err = ''; }
      catch (e) { parsed = { specs: [], skipped: [], located: 0, total: 0 }; err = 'Could not read this file: ' + (e.message || e); }
      if (parsed.specs.length > MAX_ROWS) parsed.specs = parsed.specs.slice(0, MAX_ROWS);
    }
    parse();
    var o = overlay(
      '<div class="cbi-title">\uD83D\uDDFA Import map file <span class="cbi-sub">' + esc(src.name) + '</span></div>' +
      '<div class="cbi-row">' +
        '<label class="cbi-field" style="width:190px">Pin type<select class="cbi-input" data-k="type">' + typeOptions(st.type, ['case']) + '</select></label>' +
        '<label class="cbi-field" style="flex:1;min-width:200px">Batch name<input class="cbi-input" data-k="name" maxlength="80" value="' + esc(st.name) + '"></label>' +
      '</div>' +
      '<div class="cbi-summary" data-host="sum"></div><div data-host="prev"></div>' +
      '<div class="cbi-actions"><button class="cb-btn" data-act="cancel">Cancel</button><button class="cb-btn cb-modal-ok" data-act="ok">Import</button></div>',
      'cbi-wide');
    function render() {
      var need = parsed.specs.filter(function (s) { return s.lat == null && s.address; }).length;
      var html = err ? '<div class="cbi-warn">' + esc(err) + '</div>' :
        '<b>' + parsed.total + '</b> feature' + (parsed.total === 1 ? '' : 's') + ' \u2192 <b>' + parsed.specs.length + '</b> pins \u00B7 <span class="cbi-ok">' + parsed.located + ' with coordinates</span>' +
        (need ? ' \u00B7 <span class="cbi-geo">' + need + ' addresses to look up</span>' : '') +
        (parsed.skipped.length ? ' \u00B7 <span class="cbi-dim">' + parsed.skipped.length + ' skipped (no coordinates)</span>' : '') +
        '<div class="cbi-dim" style="margin-top:4px">Paths and areas are pinned at their centre; the shape is noted on the card.</div>';
      if (src.kind === 'geojson') html += '<div class="cbi-dim">Features with a <i>type</i> or <i>category</i> property keep it; the rest use the pin type above.</div>';
      o.q('[data-host="sum"]').innerHTML = html;
      o.q('[data-host="prev"]').innerHTML = previewTable(parsed.specs);
      var ok = o.q('[data-act="ok"]');
      ok.textContent = 'Import ' + parsed.specs.length + ' pin' + (parsed.specs.length === 1 ? '' : 's');
      ok.disabled = !parsed.specs.length;
    }
    render();
    o.box.addEventListener('change', function (e) {
      if (e.target.getAttribute('data-k') === 'type') { st.type = e.target.value; parse(); render(); }
    });
    o.box.addEventListener('click', function (e) {
      var a = e.target.closest('[data-act]'); if (!a) return;
      if (a.getAttribute('data-act') === 'cancel') { o.close(); return; }
      if (!parsed.specs.length) return;
      st.name = o.q('[data-k="name"]').value.trim() || st.name;
      var need = parsed.specs.filter(function (s) { return s.lat == null && s.address; }).length;
      var batch = { id: st.batchId, name: st.name, kind: src.kind, file: src.name, importedAt: new Date().toISOString(),
        count: parsed.specs.length, located: parsed.located, needGeocode: need };
      o.close();
      commitImport(batch, parsed.specs);
    });
  }

  // ── image helpers ────────────────────────────────────────────
  function blobToDataUrl(b) {
    return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = rej; fr.readAsDataURL(b); });
  }
  function dataUrlToFile(dataUrl, name) {
    var m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(dataUrl || '');
    if (!m) return null;
    var bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new File([u8], name, { type: m[1], lastModified: Date.now() });
  }
  function makeThumb(dataUrl, max) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var s = Math.min(1, max / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
        var g = c.getContext('2d'); g.fillStyle = '#0a0e14'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        try { resolve(c.toDataURL('image/jpeg', 0.82)); } catch (_) { resolve(''); }
      };
      img.onerror = function () { resolve(''); };
      img.src = dataUrl;
    });
  }

  // ── card modal (paste / screenshot / tray capture) ──────────
  var activeCard = null;
  /**
   * o: {image: dataUrl|File|Blob, text, source, sourceUrl, title, capturedAt, kind: 'paste'|'tray'|'file', onClose}
   */
  function openCardModal(o) {
    o = o || {};
    if (!curCase()) { toast('Open a case first', 'warning'); if (o.onClose) o.onClose(); return; }
    if (activeCard) activeCard.close();
    var st = { dataUrl: '', file: null };
    var pins = (CB() && CB().listPins) ? CB().listPins() : [];
    pins.sort(function (a, b) { return String(a.label).localeCompare(String(b.label)); });
    var firstLine = String(o.text || '').split(/\r?\n/).filter(function (l) { return l.trim(); })[0] || '';
    var heading = o.kind === 'tray' ? '\uD83E\uDDF5 Send to board <span class="cbi-sub">' + esc(o.source || '') + '</span>' : '\uD83D\uDCCB Add a card to the board';

    var m = overlay(
      '<div class="cbi-title">' + heading + '</div>' +
      '<div class="cbi-pastezone" data-host="img"></div>' +
      '<div class="cbi-form">' +
        '<label class="cbi-field cbi-span2">Title<input class="cbi-input" data-k="title" maxlength="120"></label>' +
        '<label class="cbi-field">Type<select class="cbi-input" data-k="type">' + typeOptions('note', ['case']) + '</select></label>' +
        '<label class="cbi-field">Captured<input class="cbi-input" type="datetime-local" data-k="when"></label>' +
        '<label class="cbi-field">Source<input class="cbi-input" data-k="source" maxlength="160" placeholder="Who/where: TLO report, Facebook, tip line\u2026"></label>' +
        '<label class="cbi-field">Address<input class="cbi-input" data-k="address" maxlength="200" placeholder="Optional: puts the card on the map"></label>' +
        '<label class="cbi-field">Link to existing card<select class="cbi-input" data-k="link"><option value="">\u2014 none \u2014</option>' +
          pins.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(String(p.label).slice(0, 60)) + ' (' + esc(p.typeLabel) + ')</option>'; }).join('') + '</select></label>' +
        '<label class="cbi-field">Link label<input class="cbi-input" data-k="linklabel" maxlength="60" placeholder="e.g. found on, same phone"></label>' +
        '<label class="cbi-field cbi-span2">Notes<textarea class="cbi-input" data-k="notes" rows="3"></textarea></label>' +
        '<label class="cbi-check cbi-span2" data-host="evrow"><input type="checkbox" data-k="evidence" checked> Save the image to Evidence (original file, with source and capture time)</label>' +
      '</div>' +
      '<div class="cbi-actions"><button class="cb-btn" data-act="cancel">Cancel</button><button class="cb-btn cb-modal-ok" data-act="ok">\uD83E\uDDF5 Add to board</button></div>',
      'cbi-card',
      function () {
        window.removeEventListener('paste', onPaste, true);
        if (activeCard === handle) activeCard = null;
        if (o.onClose) o.onClose();
      });
    var handle = { close: m.close, setImage: setImage };
    activeCard = handle;

    m.q('[data-k="title"]').value = o.title || firstLine.slice(0, 80) || '';
    m.q('[data-k="when"]').value = o.capturedAt || nowLocalInput();
    m.q('[data-k="source"]').value = o.source || '';
    m.q('[data-k="notes"]').value = o.text || '';

    function renderImg() {
      var host = m.q('[data-host="img"]');
      if (st.dataUrl) {
        host.className = 'cbi-pastezone cbi-has-img';
        host.innerHTML = '<img src="' + st.dataUrl + '" alt="capture"><button class="cb-btn cbi-img-x" data-act="noimg" title="Remove the image">\u2715</button>';
      } else {
        host.className = 'cbi-pastezone';
        host.innerHTML = '<div>Paste a screenshot here (<b>Ctrl+V</b>), drop an image, or <a href="#" data-act="pick">choose a file</a>.</div>' +
          '<div class="cbi-dim">Text works too: paste it into Notes.</div>';
      }
      m.q('[data-host="evrow"]').style.display = st.dataUrl ? '' : 'none';
    }
    function setImage(img) {
      if (!img) { st.dataUrl = ''; st.file = null; renderImg(); return; }
      if (typeof img === 'string') { st.dataUrl = img; st.file = null; renderImg(); afterImage(); return; }
      st.file = img;
      blobToDataUrl(img).then(function (d) { st.dataUrl = d; renderImg(); afterImage(); });
    }
    function afterImage() {
      var ty = m.q('[data-k="type"]');
      if (ty.value === 'note') ty.value = 'image';
      var ti = m.q('[data-k="title"]');
      if (!ti.value) ti.value = o.kind === 'tray' ? (o.source || 'Capture') : 'Screenshot';
    }
    function onPaste(e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
          var f = items[i].getAsFile();
          if (f) { e.preventDefault(); e.stopPropagation(); setImage(new File([f], 'Board-paste_' + stamp() + '.' + (f.type.split('/')[1] || 'png'), { type: f.type })); return; }
        }
      }
      // Text: let it land wherever the cursor is; outside a field it goes to Notes.
      if (!isEditable(document.activeElement)) {
        var t = e.clipboardData && e.clipboardData.getData('text/plain');
        if (t) { e.preventDefault(); var n = m.q('[data-k="notes"]'); n.value = (n.value ? n.value + '\n' : '') + t; if (!m.q('[data-k="title"]').value) m.q('[data-k="title"]').value = t.trim().split(/\r?\n/)[0].slice(0, 80); }
      }
    }
    window.addEventListener('paste', onPaste, true);

    renderImg();
    if (o.image) setImage(o.image);
    else if (o.text) m.q('[data-k="type"]').value = 'note';
    setTimeout(function () { var t = m.q('[data-k="title"]'); if (t) t.focus(); }, 30);

    m.box.addEventListener('click', function (e) {
      var a = e.target.closest('[data-act]'); if (!a) return;
      e.preventDefault();
      var act = a.getAttribute('data-act');
      if (act === 'cancel') { m.close(); return; }
      if (act === 'noimg') { setImage(null); return; }
      if (act === 'pick') { pickFile('image/*').then(function (f) { if (f) setImage(f); }); return; }
      if (act === 'ok') submit(a);
    });

    function submit(btn) {
      var title = m.q('[data-k="title"]').value.trim();
      var notes = m.q('[data-k="notes"]').value.trim();
      if (!title && !notes && !st.dataUrl) { toast('Add a title, some text or an image first', 'warning'); return; }
      var type = m.q('[data-k="type"]').value || 'note';
      var when = (m.q('[data-k="when"]').value || '').replace('T', ' ');
      var source = m.q('[data-k="source"]').value.trim();
      var address = m.q('[data-k="address"]').value.trim();
      var linkTo = m.q('[data-k="link"]').value;
      var linkLabel = m.q('[data-k="linklabel"]').value.trim();
      var toEvidence = st.dataUrl && m.q('[data-k="evidence"]').checked;
      btn.disabled = true; btn.textContent = 'Saving\u2026';

      var data = { notes: notes, capture: { source: source, url: o.sourceUrl || '', capturedAt: when, kind: o.kind || 'paste' } };
      var spec = { type: type, label: title || (notes ? notes.split(/\r?\n/)[0].slice(0, 80) : 'Screenshot'), address: address, data: data };

      var thumbJob = st.dataUrl ? makeThumb(st.dataUrl, 560) : Promise.resolve('');
      var evJob = Promise.resolve(null);
      if (toEvidence) {
        var file = st.file || dataUrlToFile(st.dataUrl, (o.kind === 'tray' ? 'Board-capture_' : 'Board-paste_') + stamp() + '.png');
        var desc = 'Connection Board ' + (o.kind === 'tray' ? 'capture' : 'card') + ': ' + spec.label +
          (source ? ' \u00B7 source: ' + source : '') + (o.sourceUrl ? ' (' + o.sourceUrl + ')' : '') + (when ? ' \u00B7 captured ' + when : '');
        evJob = file ? CB().saveToEvidence(file, true, { description: desc }).then(function (r) { return r ? { r: r, file: file } : null; }) : Promise.resolve(null);
      }
      Promise.all([thumbJob, evJob]).then(function (res) {
        spec.photo = res[0] || '';
        if (res[1] && res[1].r && res[1].r.savedPath) {
          data.media = [{ path: res[1].r.savedPath, name: res[1].file.name, mime: res[1].file.type || 'image/png', kind: 'image' }];
          if (res[1].r.evidenceId) data.evidenceId = res[1].r.evidenceId;
        } else if (toEvidence) {
          toast('Could not save the image to Evidence; the card keeps a thumbnail only', 'warning');
        }
        var id = CB().addCard(spec, { linkTo: linkTo || null, linkLabel: linkLabel });
        if (id) toast('Added \u201C' + spec.label + '\u201D to the board' + (res[1] ? ' and Evidence' : '') + (boardOpen() ? '' : ' (open the Connection Board to see it)'), 'success');
        m.close();
      }).catch(function (e) {
        console.error('[CBImport] card', e);
        toast('Could not add the card: ' + (e.message || e), 'error');
        btn.disabled = false; btn.textContent = '\uD83E\uDDF5 Add to board';
      });
    }
    return handle;
  }

  // ── Import menu ──────────────────────────────────────────────
  var menuEl = null;
  function closeMenu() {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
    document.removeEventListener('mousedown', outside, true);
    window.removeEventListener('keydown', menuKey, true);
  }
  function outside(e) { if (menuEl && !menuEl.contains(e.target) && !(e.target.closest && e.target.closest('#cbImportBtn'))) closeMenu(); }
  function menuKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); } }

  function openMenu(anchor) {
    if (menuEl) { closeMenu(); return; }
    if (!curCase()) { toast('Open a case first', 'warning'); return; }
    var batches = loadBatches().slice().reverse();
    var kindIcon = { csv: '\uD83D\uDCC4', xlsx: '\uD83D\uDCCA', paste: '\uD83D\uDCCB', kml: '\uD83D\uDDFA', kmz: '\uD83D\uDDFA', geojson: '\uD83D\uDDFA' };
    menuEl = document.createElement('div');
    menuEl.className = 'cbi-menu';
    menuEl.innerHTML =
      '<button class="cbi-mi" data-act="sheet">\uD83D\uDCCA Spreadsheet\u2026<small>CSV, TSV or XLSX. Map the columns to name, address, coordinates, time</small></button>' +
      '<button class="cbi-mi" data-act="mapfile">\uD83D\uDDFA Map file\u2026<small>KML, KMZ (Google Earth, My Maps) or GeoJSON</small></button>' +
      '<button class="cbi-mi" data-act="card">\uD83D\uDCCB Paste text or screenshot\u2026<small>Makes a card with its source and capture time</small></button>' +
      '<div class="cbi-mtip">Tip: drop files onto the board, or press Ctrl+V on it. Rows copied from Excel open the column mapper.</div>' +
      (batches.length ? '<div class="cbi-mhead">IMPORTED BATCHES</div>' + batches.map(function (b) {
        var live = CB().countBySourceType ? CB().countBySourceType('import:' + b.id) : b.count;
        return '<div class="cbi-batch" data-id="' + esc(b.id) + '">' +
          '<span class="cbi-bname" title="' + esc(b.file || b.name) + '">' + (kindIcon[b.kind] || '\uD83D\uDCC4') + ' ' + esc(b.name) + '</span>' +
          '<span class="cbi-dim">' + live + ' pin' + (live === 1 ? '' : 's') + ' \u00B7 ' + esc(String(b.importedAt || '').slice(0, 10)) + '</span>' +
          (b.needGeocode ? '<button class="cb-btn cbi-mini" data-act="locate" title="Look up any addresses that are not on the map yet">\uD83D\uDCCD Locate</button>' : '') +
          '<button class="cb-btn cb-btn-danger cbi-mini" data-act="remove" title="Remove every pin from this import">Remove</button>' +
        '</div>';
      }).join('') : '');
    document.body.appendChild(menuEl);
    var r = anchor ? anchor.getBoundingClientRect() : { left: 100, bottom: 60 };
    var w = menuEl.offsetWidth;
    menuEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    menuEl.style.top = (r.bottom + 6) + 'px';
    setTimeout(function () { document.addEventListener('mousedown', outside, true); }, 0);
    window.addEventListener('keydown', menuKey, true);

    menuEl.addEventListener('click', function (e) {
      var a = e.target.closest('[data-act]'); if (!a) return;
      var act = a.getAttribute('data-act');
      var row = a.closest('.cbi-batch'), bid = row && row.getAttribute('data-id');
      if (act === 'sheet') { closeMenu(); pickFile('.csv,.tsv,.txt,.xlsx,.xlsm,.xls').then(handleFile); }
      else if (act === 'mapfile') { closeMenu(); pickFile('.kml,.kmz,.geojson,.json').then(handleFile); }
      else if (act === 'card') { closeMenu(); openCardModal({ kind: 'paste' }); }
      else if (act === 'locate') { closeMenu(); var b = loadBatches().filter(function (x) { return x.id === bid; })[0]; if (b) runGeocode(b); }
      else if (act === 'remove') {
        var bb = loadBatches().filter(function (x) { return x.id === bid; })[0]; if (!bb) return;
        closeMenu();
        var ask = window.viperConfirm ? window.viperConfirm('Remove every pin imported from <b>' + esc(bb.name) + '</b>? Cards you added yourself and the rest of the board stay.', { danger: true, okText: 'Remove' }) : Promise.resolve(true);
        ask.then(function (yes) {
          if (!yes) return;
          var n = CB().removePinsBySourceType('import:' + bid);
          saveBatches(loadBatches().filter(function (x) { return x.id !== bid; }));
          toast('Removed ' + n + ' pin' + (n === 1 ? '' : 's') + ' from \u201C' + bb.name + '\u201D', 'success');
        });
      }
    });
  }

  // ── board-wide paste + file drop ─────────────────────────────
  function looksTabular(t) {
    var lines = String(t || '').split(/\r?\n/).filter(function (l) { return l.trim(); });
    return lines.length >= 2 && lines.filter(function (l) { return l.indexOf('\t') >= 0; }).length >= Math.min(lines.length, 2);
  }
  window.addEventListener('paste', function (e) {
    if (!boardOpen() || openOverlays > 0 || isEditable(e.target) || isEditable(document.activeElement)) return;
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
        var f = items[i].getAsFile();
        if (f) { e.preventDefault(); openCardModal({ image: new File([f], 'Board-paste_' + stamp() + '.' + (f.type.split('/')[1] || 'png'), { type: f.type }), kind: 'paste' }); return; }
      }
    }
    var t = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!t || !t.trim()) return;
    e.preventDefault();
    if (looksTabular(t)) {
      var nm = 'Pasted rows ' + new Date().toLocaleString();
      openMapper({ name: nm, kind: 'paste', sheets: [{ name: nm, rows: P().parseDelimited(t, '\t') }] });
    } else {
      openCardModal({ text: t, kind: 'paste' });
    }
  }, false);

  var dropHint = null, dropTimer = null;
  function hasFiles(e) { var ty = e.dataTransfer && e.dataTransfer.types; return !!ty && Array.prototype.indexOf.call(ty, 'Files') >= 0; }
  function showDropHint() {
    if (!dropHint) { dropHint = document.createElement('div'); dropHint.className = 'cbi-drop'; dropHint.innerHTML = '<div>\u2B06 Drop to import<small>CSV \u00B7 XLSX \u00B7 KML \u00B7 KMZ \u00B7 GeoJSON \u00B7 image</small></div>'; document.body.appendChild(dropHint); }
    clearTimeout(dropTimer);
    dropTimer = setTimeout(hideDropHint, 180);
  }
  function hideDropHint() { if (dropHint && dropHint.parentNode) dropHint.parentNode.removeChild(dropHint); dropHint = null; }
  window.addEventListener('dragover', function (e) {
    if (!hasFiles(e)) return;
    if (activeCard) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; return; }
    if (!boardOpen() || openOverlays > 0) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    showDropHint();
  }, true);
  window.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    var files = e.dataTransfer.files;
    if (activeCard) {
      e.preventDefault(); e.stopPropagation();
      var img = Array.prototype.filter.call(files, function (f) { return /^image\//.test(f.type); })[0];
      if (img) activeCard.setImage(img); else toast('Drop an image here', 'warning');
      return;
    }
    if (!boardOpen() || openOverlays > 0) return;
    e.preventDefault(); e.stopPropagation();
    hideDropHint();
    if (!files || !files.length) return;
    if (files.length > 1) toast('One file at a time: importing ' + files[0].name, 'info');
    handleFile(files[0]);
  }, true);

  window.CBImport = {
    openMenu: openMenu, closeMenu: closeMenu, openCardModal: openCardModal, openMapper: openMapper, openMapFile: openMapFile,
    handleFile: handleFile, listBatches: loadBatches, runGeocode: runGeocode
  };
})();
