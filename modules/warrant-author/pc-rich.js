// modules/warrant-author/pc-rich.js
// ------------------------------------------------------------------
// Probable cause as RICH TEXT — text formatting only.
//
// The Case Probable Cause editor is a contenteditable. What a warrant
// can carry from it is deliberately small: paragraphs, bold / italic /
// underline, bulleted and numbered lists (nested), indent and
// alignment. No pictures, tables, headings, fonts or sizes.
//
// Everything goes through ONE model, a list of paragraphs:
//   { runs: [{ text, bold, italics, underline }],   text may hold '\n'
//     align: '' | 'left' | 'center' | 'right' | 'justify',
//     indent: 0..8,                                  indent steps
//     list: null | 'bullet' | 'number', level: 0..8, num: 1.. }
//
//   parse(html)      → paragraphs   (string tokenizer — no DOM, so the
//                                    same code runs in node tests)
//   toHtml(paras)    → canonical, allow-listed HTML (what is stored and
//                      what the editor is loaded with)
//   toPlain(paras)   → the plain narrative every older consumer reads
//                      (validator, PA overlay, templates, word counts)
//   fromPlain(text)  → HTML for a narrative written before rich text
//   toBlocks(paras, base) → block-builder 'paragraph' blocks with runs
// ------------------------------------------------------------------

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WarrantAuthorPcRich = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_LEVEL = 8;
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '\u2013', mdash: '\u2014',
    lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', hellip: '\u2026', bull: '\u2022', sect: '\u00a7',
    para: '\u00b6', copy: '\u00a9', reg: '\u00ae', deg: '\u00b0', middot: '\u00b7', shy: '' };

  function decode(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        if (!isFinite(n) || n <= 0 || n > 0x10ffff) return '';
        try { return String.fromCodePoint(n); } catch (_) { return ''; }
      }
      const v = NAMED[e.toLowerCase()];
      return v == null ? m : v;
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function attrOf(attrs, name) {
    const re = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
    const m = re.exec(attrs || '');
    return m ? decode(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]) : '';
  }

  function styleOf(attrs) {
    const out = {};
    attrOf(attrs, 'style').split(';').forEach((decl) => {
      const i = decl.indexOf(':');
      if (i < 0) return;
      const k = decl.slice(0, i).trim().toLowerCase();
      const v = decl.slice(i + 1).trim().toLowerCase();
      if (k) out[k] = v;
    });
    return out;
  }

  function pxOf(v) {
    const m = /^(-?[\d.]+)\s*(px|pt|em|rem|in)?$/.exec(String(v || '').trim());
    if (!m) return 0;
    const n = parseFloat(m[1]);
    const u = m[2] || 'px';
    return u === 'pt' ? n * 4 / 3 : u === 'em' || u === 'rem' ? n * 16 : u === 'in' ? n * 96 : n;
  }

  function normAlign(v) {
    v = String(v || '').trim().toLowerCase();
    if (v === 'center' || v === '-webkit-center') return 'center';
    if (v === 'right' || v === 'end' || v === '-webkit-right') return 'right';
    if (v === 'justify') return 'justify';
    if (v === 'left' || v === 'start' || v === '-webkit-left') return 'left';
    return '';
  }

  const VOID = /^(br|img|hr|input|meta|link|col|area|base|embed|param|source|track|wbr)$/;
  const SKIP = /^(script|style|head|title|template|noscript|object|iframe|svg|math|select|textarea|button)$/;
  const BLOCK = /^(p|div|li|ul|ol|h[1-6]|blockquote|pre|table|thead|tbody|tfoot|tr|td|th|caption|section|article|header|footer|aside|nav|main|figure|figcaption|address|dl|dt|dd|center)$/;

  // ── HTML → paragraphs ────────────────────────────────────────────────
  function parse(html) {
    const src = String(html == null ? '' : html);
    const paras = [];
    const stack = [];
    let cur = null;
    let skip = 0;
    let lastSpace = true;

    function frameFor(tag, attrs) {
      const st = styleOf(attrs);
      const f = { tag };
      if (tag === 'b' || tag === 'strong' || /^h[1-6]$/.test(tag) || tag === 'th') f.bold = true;
      if (tag === 'i' || tag === 'em' || tag === 'cite' || tag === 'var') f.italics = true;
      if (tag === 'u' || tag === 'ins') f.underline = true;
      const fw = st['font-weight'];
      if (fw) {
        if (/^(bold|bolder)$/.test(fw) || (/^\d+$/.test(fw) && +fw >= 600)) f.bold = true;
        else if (/^(normal|lighter)$/.test(fw) || (/^\d+$/.test(fw) && +fw < 600)) f.bold = false;
      }
      const fs = st['font-style'];
      if (fs) f.italics = /italic|oblique/.test(fs);
      const td = st['text-decoration-line'] || st['text-decoration'];
      if (td) { if (/underline/.test(td)) f.underline = true; else if (/none/.test(td)) f.underline = false; }
      const al = normAlign(st['text-align'] || attrOf(attrs, 'align'));
      if (al && BLOCK.test(tag)) f.align = al;
      if (tag === 'center') f.align = 'center';
      if (tag === 'blockquote') f.indent = 1;
      else if (/^(p|div)$/.test(tag)) {
        const ml = pxOf(st['margin-left']) + pxOf(st['padding-left']);
        if (ml >= 20) f.indent = Math.min(MAX_LEVEL, Math.round(ml / 40) || 1);
      }
      if (tag === 'ul') { f.list = 'bullet'; f.count = 0; }
      if (tag === 'ol') { f.list = 'number'; const s = parseInt(attrOf(attrs, 'start'), 10); f.count = isFinite(s) ? s - 1 : 0; }
      return f;
    }

    function fmt() {
      const o = { bold: false, italics: false, underline: false };
      for (const f of stack) {
        if (f.bold != null) o.bold = f.bold;
        if (f.italics != null) o.italics = f.italics;
        if (f.underline != null) o.underline = f.underline;
      }
      return o;
    }

    function newPara() {
      let align = '', indent = 0, level = -1, listType = null, li = null;
      for (const f of stack) {
        if (f.align) align = f.align;
        if (f.indent) indent += f.indent;
        if (f.list) { level++; listType = f.list; }
        if (f.tag === 'li') li = f;
      }
      const p = { runs: [], align, indent: Math.min(MAX_LEVEL, indent), list: null, level: 0, num: 0 };
      if (li && !li.used) {
        li.used = true;
        p.list = li.listType || listType || 'bullet';
        p.level = Math.max(0, Math.min(MAX_LEVEL, level));
        p.num = li.num || 1;
      } else if (li) {
        // A second paragraph inside one list item: indented under its text.
        p.indent = Math.min(MAX_LEVEL, p.indent + Math.max(0, level) + 1);
      }
      return p;
    }

    function flush() {
      if (!cur) return;
      const p = cur;
      cur = null;
      lastSpace = true;
      // Trim breaks + spaces at both ends.
      while (p.runs.length) {
        const r = p.runs[0];
        r.text = r.text.replace(/^[ \n]+/, '');
        if (r.text) break;
        p.runs.shift();
      }
      while (p.runs.length) {
        const r = p.runs[p.runs.length - 1];
        r.text = r.text.replace(/[ \n]+$/, '');
        if (r.text) break;
        p.runs.pop();
      }
      if (!p.runs.some((r) => /\S/.test(r.text))) return;
      p.runs.forEach((r) => { r.text = r.text.replace(/\u00a0/g, ' '); });
      paras.push(p);
    }

    function push(text) {
      if (!cur) cur = newPara();
      const f = fmt();
      const last = cur.runs[cur.runs.length - 1];
      if (last && last.bold === f.bold && last.italics === f.italics && last.underline === f.underline) last.text += text;
      else cur.runs.push({ text, bold: f.bold, italics: f.italics, underline: f.underline });
    }

    function addText(raw) {
      let t = decode(raw).replace(/[ \t\r\n\f]+/g, ' ');
      if (!t) return;
      if (lastSpace) t = t.replace(/^ /, '');
      if (!t) return;
      if (!cur && !/\S/.test(t.replace(/\u00a0/g, ' '))) return;
      push(t);
      lastSpace = / $/.test(t);
    }

    const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
    let m;
    while ((m = re.exec(src))) {
      const tok = m[0];
      if (m[2] == null) {
        if (tok[0] === '<' && tok.length > 1) continue;   // comment / doctype / PI
        if (!skip) addText(tok);
        continue;
      }
      const close = m[1] === '/';
      const tag = m[2].toLowerCase().replace(/^.*:/, '');
      const attrs = m[3] || '';
      if (SKIP.test(tag)) {
        if (close) skip = Math.max(0, skip - 1);
        else if (!/\/\s*$/.test(attrs)) skip++;
        continue;
      }
      if (skip) continue;
      if (tag === 'br') {
        if (cur) { push('\n'); lastSpace = true; }
        continue;
      }
      if (tag === 'hr') { flush(); continue; }
      if (VOID.test(tag)) continue;
      const block = BLOCK.test(tag);
      if (!close) {
        if (block) flush();
        const f = frameFor(tag, attrs);
        if (tag === 'li') {
          let lst = null;
          for (let i = stack.length - 1; i >= 0; i--) if (stack[i].list) { lst = stack[i]; break; }
          if (lst) { lst.count++; f.num = lst.count; f.listType = lst.list; }
          else { f.num = 1; f.listType = 'bullet'; }
        }
        if (/\/\s*$/.test(attrs)) continue;
        stack.push(f);
      } else {
        let i = stack.length - 1;
        while (i >= 0 && stack[i].tag !== tag) i--;
        if (i < 0) continue;
        if (block || stack.slice(i).some((f) => BLOCK.test(f.tag))) flush();
        stack.length = i;
      }
    }
    flush();
    return paras;
  }

  // ── paragraphs → HTML / plain ────────────────────────────────────────
  function runsHtml(runs) {
    return (runs || []).map((r) => {
      let h = esc(r.text).replace(/\n/g, '<br>');
      if (r.underline) h = '<u>' + h + '</u>';
      if (r.italics) h = '<i>' + h + '</i>';
      if (r.bold) h = '<b>' + h + '</b>';
      return h;
    }).join('');
  }

  function alignAttr(p) {
    return p.align && p.align !== 'left' ? ' style="text-align:' + p.align + '"' : (p.align === 'left' ? ' style="text-align:left"' : '');
  }

  const BQ = '<blockquote style="margin:0 0 0 40px;border:none;padding:0">';

  function toHtml(paras) {
    let out = '';
    const stack = [];   // open lists: { t:'ul'|'ol', li:boolean }
    const closeTo = (n) => {
      while (stack.length > n) {
        const s = stack.pop();
        if (s.li) out += '</li>';
        out += '</' + s.t + '>';
      }
    };
    for (const p of paras || []) {
      if (!p || !Array.isArray(p.runs)) continue;
      if (!p.list) {
        closeTo(0);
        const n = Math.max(0, Math.min(MAX_LEVEL, p.indent | 0));
        out += BQ.repeat(n) + '<p' + alignAttr(p) + '>' + runsHtml(p.runs) + '</p>' + '</blockquote>'.repeat(n);
        continue;
      }
      const L = Math.max(0, Math.min(MAX_LEVEL, p.level | 0));
      const t = p.list === 'number' ? 'ol' : 'ul';
      closeTo(L + 1);
      if (stack.length === L + 1 && stack[L].t !== t) closeTo(L);
      while (stack.length < L + 1) {
        const top = stack[stack.length - 1];
        if (top && !top.li) { out += '<li>'; top.li = true; }
        const isTarget = stack.length === L;
        const tt = isTarget ? t : t;
        const startAttr = isTarget && t === 'ol' && (p.num | 0) > 1 ? ' start="' + (p.num | 0) + '"' : '';
        out += '<' + tt + startAttr + '>';
        stack.push({ t: tt, li: false });
      }
      const top = stack[L];
      if (top.li) out += '</li>';
      out += '<li' + alignAttr(p) + '>' + runsHtml(p.runs);
      top.li = true;
    }
    closeTo(0);
    return out;
  }

  function paraText(p) {
    return (p.runs || []).map((r) => r.text).join('');
  }

  function marker(p) {
    if (!p || !p.list) return '';
    return p.list === 'number' ? (p.num | 0 || 1) + '.' : '\u2022';
  }

  function toPlain(paras) {
    let out = '';
    let prevList = false;
    (paras || []).forEach((p, i) => {
      const isList = !!p.list;
      const line = (isList ? '  '.repeat(p.level | 0) + marker(p) + ' ' : '') + paraText(p);
      if (i > 0) out += (isList && prevList) ? '\n' : '\n\n';
      out += line;
      prevList = isList;
    });
    return out;
  }

  function fromPlain(text) {
    const t = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
    if (!t) return '';
    return t.split(/\n[ \t]*\n+/).map((para) => {
      const lines = para.split('\n').map((l) => esc(l.replace(/^[ \t]+|[ \t]+$/g, '')));
      return '<p>' + lines.join('<br>') + '</p>';
    }).join('');
  }

  /** Canonical HTML for anything — legacy plain text or editor HTML. */
  function canonical(html) { return toHtml(parse(html)); }

  /** Whitespace-insensitive key used to tell whether HTML and plain text agree. */
  function sameText(a, b) {
    const k = (s) => String(s == null ? '' : s).replace(/[\s\u00a0]+/g, ' ').trim();
    return k(a) === k(b);
  }

  /**
   * Paragraph blocks for the block builder. `base` carries the look the
   * surrounding template gives probable cause (size, justification,
   * first-line indent, leading); each paragraph's own alignment, indent
   * and list marker are applied on top of it.
   */
  function toBlocks(paras, base) {
    const list = (paras || []).filter((p) => p && Array.isArray(p.runs));
    return list.map((p, i) => {
      const b = Object.assign({}, base || {});
      delete b.text; delete b.rich; delete b.indent; delete b.runs;
      b.kind = 'paragraph';
      b.runs = p.runs.map((r) => ({ text: String(r.text || ''), bold: !!r.bold, italics: !!r.italics, underline: !!r.underline }));
      const mk = marker(p);
      b.text = (mk ? mk + ' ' : '') + paraText(p);
      const ind = Math.max(0, p.indent | 0);
      if (p.list) {
        b.marker = mk;
        b.leftPt = 24 + 24 * Math.max(0, p.level | 0) + 36 * ind;
        delete b.firstIndent;
        const next = list[i + 1];
        if (next && next.list) b.tight = true;
      } else if (ind) {
        b.leftPt = 36 * ind;
      }
      if (p.align === 'center' || p.align === 'right') { b.align = p.align; b.justify = false; delete b.firstIndent; }
      else if (p.align === 'justify') { b.justify = true; delete b.align; }
      else if (p.align === 'left') { b.justify = false; delete b.align; }
      return b;
    });
  }

  return { parse, toHtml, toPlain, fromPlain, canonical, sameText, toBlocks, marker, paraText, decode, esc };
}));
