// Throwaway: extract inline <script> blocks from an HTML file and syntax-check
// each one with the V8 parser. Catches the class of error that otherwise only
// shows up as a blank page at runtime.
import fs from "node:fs";
import vm from "node:vm";

const file = process.argv[2];
const html = fs.readFileSync(file, "utf8");
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let m, i = 0, bad = 0;
while ((m = re.exec(html))) {
  const attrs = m[1] || "";
  if (/\bsrc\s*=/i.test(attrs)) continue;
  if (/type\s*=\s*["']?(application\/json|text\/template)/i.test(attrs)) continue;
  i++;
  const line = html.slice(0, m.index).split("\n").length;
  try {
    new vm.Script(m[2], { filename: `${file}:script#${i}@line${line}` });
  } catch (e) {
    bad++;
    console.log(`FAIL block#${i} starting line ${line}: ${e.message}`);
  }
}
console.log(bad ? `SYNTAX_FAIL (${bad}/${i} blocks)` : `SYNTAX_OK (${i} inline blocks)`);
process.exit(bad ? 1 : 0);
