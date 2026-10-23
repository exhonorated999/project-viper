/**
 * VIPER Scout — a VIPER crash log (Settings → Crash Log) submitted as a
 * .txt keeps the whole log, redacted, instead of the 3-line excerpt every
 * other text file gets. Oct 2026: submission #24 (a 5,993-file Evidence
 * folder crash) arrived with only the header — nothing that explained it.
 *
 * Synthetic log only (203.0.113.x / 198.51.100.x).
 * Run: node modules\parser-submission\__tests__\crash-log-excerpt.test.js
 */
const assert = require('assert');
const SB = require('../sample-builder')._internal;

let passed = 0, failed = 0;
function ok(label, fn) {
    try { fn(); console.log('  PASS  ' + label); passed++; }
    catch (e) { console.log('  FAIL  ' + label + '  ' + e.message); failed++; }
}

const LOG = [
    'VIPER 5.4.8 crash log · exported 2026-10-22T18:04:11Z · portable=true · native crash dumps on this PC: 3',
    '',
    '2026-10-22T17:58:01.112Z [START] VIPER 5.4.8 pid=4242 portable=true rss=66MB heap=8MB',
    '2026-10-22T17:58:40.551Z [MARK] evidence-open files=5993',
    "2026-10-22T17:59:02.004Z [ERROR] Error: ENOENT: no such file or directory, open 'E:\\Cases\\Doe John 2026-04417\\Bit Torrent\\IMG 0042.jpg'",
    '    at Object.openSync (node:fs:573:18)',
    '2026-10-22T17:59:03.000Z [WARN] read failed D:\\Evidence\\Smith Folder\\clip one.mp4 after 3 tries',
    '2026-10-22T17:59:04.000Z [INFO] peer 203.0.113.45 and 198.51.100.7 · mail det.jones@agency.gov · case 2026004417',
    '2026-10-22T17:59:05.000Z [INFO] ipv6 2001:db8::1 seen; clock 17:59:05 kept',
    '2026-10-22T17:59:09.777Z [CRASH] renderer gone reason=oom exitCode=-536870904 rss=3900MB',
];

ok('crash log detected and kept whole (every non-empty line)', () => {
    const r = SB.inspectText(LOG.join('\r\n'));
    assert.strictEqual(r.viper_crash_log, true);
    assert.strictEqual(r.excerpt_redacted.split('\n').length, LOG.filter(Boolean).length);
    assert.ok(/\[CRASH\] renderer gone reason=oom/.test(r.excerpt_redacted), 'the line that matters');
});
const ex = SB.inspectText(LOG.join('\n')).excerpt_redacted;
ok('timestamps, levels and memory figures stay readable', () => {
    assert.ok(ex.includes('2026-10-22T17:58:01.112Z [START] VIPER 5.4.8 pid=4242 portable=true rss=66MB heap=8MB'), ex);
    assert.ok(ex.includes('evidence-open files=5993'));
    assert.ok(ex.includes('clock 17:59:05 kept'));
    assert.ok(ex.includes('at Object.openSync (node:fs:573:18)'));
});
ok('paths dropped down to the extension — spaces in folder AND file names', () => {
    assert.ok(ex.includes("open '<PATH .jpg>'"), ex);
    assert.ok(ex.includes('read failed <PATH .mp4> after 3 tries'), ex);
    for (const leak of ['Doe', 'John', '04417', 'Smith', 'Folder', 'clip', 'one.mp4', 'IMG 0042', 'Cases', 'Evidence\\']) {
        assert.ok(!ex.includes(leak), 'leaked: ' + leak);
    }
});
ok('IPs, emails, long numbers redacted', () => {
    assert.ok(!/203\.0\.113|198\.51\.100/.test(ex)); assert.ok(ex.includes('peer <IPV4> and <IPV4>'));
    assert.ok(!ex.includes('jones') && ex.includes('<EMAIL>'));
    assert.ok(ex.includes('case <NUM 10>'));
    assert.ok(ex.includes('ipv6 <IPV6> seen'));
});
ok('long log: header + newest lines kept, middle marked', () => {
    const big = [LOG[0]];
    for (let i = 0; i < 1000; i++) big.push('2026-10-22T17:00:00.000Z [INFO] line ' + i);
    big.push('2026-10-22T17:59:09.777Z [CRASH] the end');
    const e = SB.inspectText(big.join('\n')).excerpt_redacted;
    const ls = e.split('\n');
    assert.strictEqual(ls.length, SB.CRASH_LOG_MAX_LINES);
    assert.ok(ls[0].startsWith('VIPER 5.4.8 crash log'));
    assert.ok(/earlier lines left out/.test(e));
    assert.strictEqual(ls[ls.length - 1], '2026-10-22T17:59:09.777Z [CRASH] the end');
});
ok('any other .txt still gets the 3-line excerpt', () => {
    const r = SB.inspectText('hello one\nhello two\nhello three\nhello four\n');
    assert.strictEqual(r.viper_crash_log, undefined);
    assert.strictEqual(r.excerpt_redacted.split('\n').length, 3);
});
ok('"crash log" mid-text does not trigger it', () => {
    const r = SB.inspectText('Notes\nVIPER 5.4.8 crash log · x\nmore\nmore');
    assert.strictEqual(r.viper_crash_log, undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
