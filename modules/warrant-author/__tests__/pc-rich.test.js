// modules/warrant-author/__tests__/pc-rich.test.js
// Probable cause rich text (text formatting only): HTML ↔ paragraph model,
// canonical HTML, plain narrative, and block-builder paragraph blocks.
// SYNTHETIC text only.
//
// Run: node modules/warrant-author/__tests__/pc-rich.test.js
'use strict';
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const R = require(path.join(ROOT, 'modules', 'warrant-author', 'pc-rich.js'));

let pass = 0, fail = 0;
function eq(a, b, msg) {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A === B) pass++; else { fail++; console.log('  FAIL:', msg, '\n    got:', A, '\n    exp:', B); }
}
function ok(c, msg) { if (c) pass++; else { fail++; console.log('  FAIL:', msg); } }

const brief = (paras) => paras.map((p) => ({
  t: R.paraText(p), a: p.align, i: p.indent, l: p.list, v: p.level, n: p.num,
  r: p.runs.map((r) => (r.bold ? 'B' : '') + (r.italics ? 'I' : '') + (r.underline ? 'U' : '') + ':' + r.text),
}));

console.log('— parse: paragraphs + inline formatting');
let P = R.parse('<p>One <b>bold</b> and <i>it</i> and <u>under</u>.</p><p>Two</p>');
eq(P.length, 2, 'two paragraphs');
eq(brief(P)[0].r, [':One ', 'B:bold', ': and ', 'I:it', ': and ', 'U:under', ':.'], 'runs');
P = R.parse('<div>A <span style="font-weight: 700;">B</span> <span style="font-style:italic;text-decoration:underline">C</span></div>');
eq(brief(P)[0].r, [':A ', 'B:B', ': ', 'IU:C'], 'span styles');
P = R.parse('<b>Bold <span style="font-weight:normal">plain</span></b>');
eq(brief(P)[0].r, ['B:Bold ', ':plain'], 'font-weight normal overrides');
P = R.parse('Typed directly<div>second line</div><div><br></div><div>third</div>');
eq(brief(P).map((p) => p.t), ['Typed directly', 'second line', 'third'], 'Chromium div lines; empty div dropped');
P = R.parse('<p>line1<br>line2</p>');
eq(brief(P)[0].t, 'line1\nline2', 'br kept as newline');
P = R.parse('<p>  lots   of\n  space&nbsp;here &amp; &lt;x&gt; &#8212; &#x2019;</p>');
eq(brief(P)[0].t, 'lots of space here & <x> \u2014 \u2019', 'whitespace collapse + entities');
P = R.parse('<p><img src="x.png"> pic</p><table><tr><td>cell</td></tr></table><script>bad()</script>');
eq(brief(P).map((p) => p.t), ['pic', 'cell'], 'images dropped, table text kept as paragraphs, script skipped');

console.log('— parse: alignment + indent');
P = R.parse('<p style="text-align:center">C</p><div style="text-align: right;">R</div><p align="justify">J</p>');
eq(brief(P).map((p) => p.a), ['center', 'right', 'justify'], 'alignment');
P = R.parse('<blockquote style="margin: 0 0 0 40px; border: none; padding: 0px;"><p>I1</p><blockquote style="margin:0 0 0 40px"><p>I2</p></blockquote></blockquote><p style="margin-left:80px">M2</p>');
eq(brief(P).map((p) => p.i), [1, 2, 2], 'blockquote nesting + margin-left');

console.log('— parse: lists');
P = R.parse('<ul><li>a</li><li>b<ul><li>b1</li></ul></li></ul><ol><li>one</li><li>two</li></ol><ol start="5"><li>five</li></ol>');
eq(brief(P).map((p) => [p.t, p.l, p.v, p.n]), [
  ['a', 'bullet', 0, 1], ['b', 'bullet', 0, 2], ['b1', 'bullet', 1, 1],
  ['one', 'number', 0, 1], ['two', 'number', 0, 2], ['five', 'number', 0, 5]], 'lists, nesting, start');
P = R.parse('<ol><li><p>first</p><p>more</p></li></ol>');
eq(brief(P).map((p) => [p.t, p.l, p.i]), [['first', 'number', 0], ['more', null, 1]], 'continuation paragraph in li');

console.log('— toHtml / canonical round-trip');
const SRC = '<p style="text-align:justify">Affiant <b>states</b> <i>that</i> <u>x</u>.</p>' +
  '<ul><li>a</li><li>b<ul><li>b1</li></ul></li></ul><p>mid</p><ol start="3"><li>three</li></ol>' +
  '<blockquote style="margin:0 0 0 40px;border:none;padding:0"><p style="text-align:center">ind</p></blockquote><p>x<br>y</p>';
const H1 = R.canonical(SRC);
eq(R.canonical(H1), H1, 'canonical is idempotent');
eq(brief(R.parse(H1)), brief(R.parse(SRC)), 'canonical keeps the model');
ok(!/<img|<table|<script/i.test(R.canonical('<img src=x><table><tr><td>t</td></tr></table><script>a</script>')), 'canonical allow-list');
eq(R.canonical('<p>a &lt;b&gt; &amp; "q"</p>'), '<p>a &lt;b&gt; &amp; &quot;q&quot;</p>', 'canonical escapes');

console.log('— toPlain / fromPlain');
eq(R.toPlain(R.parse(SRC)), 'Affiant states that x.\n\n\u2022 a\n\u2022 b\n  \u2022 b1\n\nmid\n\n3. three\n\nind\n\nx\ny', 'toPlain');
eq(R.fromPlain('Para one\nline two\n\n\nPara <two>'), '<p>Para one<br>line two</p><p>Para &lt;two&gt;</p>', 'fromPlain');
eq(R.fromPlain(''), '', 'fromPlain empty');
const legacy = 'First paragraph.\n\nSecond paragraph\nwith a break.';
eq(R.toPlain(R.parse(R.fromPlain(legacy))), legacy, 'legacy plain survives the round trip');
ok(R.sameText('a  b\n\nc', ' a b c '), 'sameText whitespace-insensitive');
ok(!R.sameText('a b', 'a c'), 'sameText differs');

console.log('— toBlocks');
const base = { kind: 'paragraph', text: 'IGNORED', justify: true, firstIndent: 36, size: 12, lh: 18 };
const B = R.toBlocks(R.parse('<p>Plain <b>bold</b></p><ul><li>a</li><li>b</li></ul><p style="text-align:center">c</p><blockquote style="margin:0 0 0 40px"><p>ind</p></blockquote><ol><li>x</li></ol>'), base);
eq(B.length, 6, 'six blocks');
eq(B[0].text, 'Plain bold', 'text = plain');
eq(B[0].runs, [{ text: 'Plain ', bold: false, italics: false, underline: false }, { text: 'bold', bold: true, italics: false, underline: false }], 'runs copied');
eq([B[0].justify, B[0].firstIndent, B[0].size, B[0].lh], [true, 36, 12, 18], 'base look kept');
eq([B[1].marker, B[1].leftPt, B[1].firstIndent, B[1].tight, B[1].text], ['\u2022', 24, undefined, true, '\u2022 a'], 'bullet a (tight before b)');
eq([B[2].marker, B[2].tight], ['\u2022', undefined], 'bullet b not tight (next is a paragraph)');
eq([B[3].align, B[3].justify, B[3].firstIndent], ['center', false, undefined], 'centered');
eq([B[4].leftPt, B[4].firstIndent], [36, 36], 'indented paragraph');
eq([B[5].marker, B[5].text], ['1.', '1. x'], 'numbered');
ok(!('text' in base && base.text !== 'IGNORED'), 'base untouched');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
