#!/usr/bin/env node
'use strict';
/**
 * Build a VIPER agency pack (.viperpack) from an agency's warrant template library.
 *
 *   node scripts/build-agency-pack.js --source <folder> --rules <rules.json> --id <pack-id>
 *        --name "<display name>" [--agency "<agency>"] --version <x.y.z> [--description "..."]
 *        --out <file.viperpack> [--config app_config.json] [--templates templates_v2]
 *
 * <folder> holds the library's config (default app_config.json) and its templates folder
 * (default templates_v2, else templates). Only templates named in the config are packed.
 * <rules.json> is the agency's Builder rules (counties, court districts, filename words, …);
 * it goes into the manifest's `builder` block.
 *
 * The output is the agency's own material: it is refused inside this repository and must
 * never be committed or bundled with the app. Give it to the agency's officers directly.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { createPackStore, buildPackBuffer, isSafeRelPath, ID_RE } = require('../modules/agency-packs/pack-store.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_KEYS = ['globalFields', 'templatesConfig', 'unbracketedFields', 'filenameSuffixFields'];

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) throw new Error('Unexpected argument: ' + a);
        const k = a.slice(2);
        const v = argv[i + 1];
        if (v == null || v.startsWith('--')) throw new Error('Missing value for --' + k);
        out[k] = v;
        i++;
    }
    return out;
}

function isInside(child, parent) {
    const rel = path.relative(parent, child);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function buildPack(o) {
    const need = ['source', 'rules', 'id', 'name', 'version', 'out'];
    for (const k of need) if (!o[k]) throw new Error('Missing --' + k);
    if (!ID_RE.test(o.id)) throw new Error('--id must be lowercase letters, digits and dashes');
    const out = path.resolve(o.out);
    if (!/\.viperpack$/i.test(out)) throw new Error('--out must end in .viperpack');
    if (isInside(out, REPO_ROOT) || out === REPO_ROOT) throw new Error('Refusing to write an agency pack inside the VIPER repository');

    const source = path.resolve(o.source);
    const cfgPath = path.join(source, o.config || 'app_config.json');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const config = {};
    CONFIG_KEYS.forEach(k => { if (raw[k] != null) config[k] = raw[k]; });
    let tplDir = o.templates ? path.join(source, o.templates) : path.join(source, 'templates_v2');
    if (!o.templates && !fs.existsSync(tplDir)) tplDir = path.join(source, 'templates');
    const rules = JSON.parse(fs.readFileSync(path.resolve(o.rules), 'utf8'));

    const templates = new Map();
    const rels = Object.keys(config.templatesConfig || {}).sort();
    const missing = [];
    for (const rel of rels) {
        if (!isSafeRelPath(rel)) throw new Error('Template path cannot be packed safely: ' + rel);
        const file = path.join(tplDir, ...rel.split('/'));
        if (!fs.existsSync(file)) { missing.push(rel); continue; }
        templates.set(rel, fs.readFileSync(file));
    }
    if (missing.length) throw new Error('Templates named in the config are missing:\n  ' + missing.join('\n  '));

    const { buffer } = buildPackBuffer({
        id: o.id, name: o.name, agency: o.agency, description: o.description, packVersion: o.version,
        rules, config, templates,
    }, { AdmZip, crypto });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, buffer);

    // Read it back exactly as the installer will.
    const store = createPackStore({ fs, path, crypto, AdmZip, rootDir: path.join(path.dirname(out), '.unused-agency-packs') });
    const summary = store.inspect(out);
    return { out, summary, bytes: fs.statSync(out).size };
}

if (require.main === module) {
    try {
        const r = buildPack(parseArgs(process.argv.slice(2)));
        console.log(`Built ${r.out} (${(r.bytes / 1048576).toFixed(1)} MB)`);
        console.log(`  ${r.summary.name} ${r.summary.packVersion} — ${r.summary.templateCount} templates: ` +
            Object.entries(r.summary.categories).map(([c, n]) => `${n} ${c}`).join(', '));
    } catch (e) {
        console.error('build-agency-pack: ' + (e.message || e));
        process.exit(1);
    }
}

module.exports = { buildPack, parseArgs };
