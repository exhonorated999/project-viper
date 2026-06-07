// modules/cargonet/cargonet-parser.js
// Pure parsing logic — NO electron deps so it can be unit-tested under
// plain `node`. Consumed by cargonet-main.js.

const SUBJ_RE = /CargoNet\s+([A-Za-z ]+?Alert)\s*-\s*([^,]+),\s*([A-Z]{2})\s*-\s*(.+)$/i;

const SECTION_HEADERS = [
  'Subject Driver Information',
  'Date - Time - Location',
  'Tractor Details',
  'Trailer Details',
  'Cargo Details',
  'Investigating Agency',
  'Contact Information',
  'Incident Description',
];

function normalizeBody(text) {
  if (!text) return '';
  let body = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Seek to the CargoNet structured body, drop Outlook/forwarding noise.
  const startRe = /\n(Theft of [A-Z][A-Za-z]+|Recovery of [A-Z][A-Za-z]+|Suspicious [A-Z][A-Za-z]+|Incident Description)\s*\n/;
  const m = body.match(startRe);
  if (m && m.index !== undefined) body = body.slice(m.index + 1);
  body = body.replace(/\n{3,}/g, '\n\n');
  return body.trim();
}

function extractSections(body) {
  const lines = body.split('\n');
  const out = {};
  let cur = null;
  let curBuf = [];

  const isHeader = (line) => {
    const t = line.trim();
    return SECTION_HEADERS.find(h => h.toLowerCase() === t.toLowerCase());
  };
  const flush = () => {
    if (cur) {
      const text = curBuf.join('\n').trim();
      if (!out[cur]) out[cur] = [];
      out[cur].push(text);
    }
    cur = null;
    curBuf = [];
  };

  for (const line of lines) {
    const hdr = isHeader(line);
    if (hdr) { flush(); cur = hdr; curBuf = []; continue; }
    if (cur) curBuf.push(line);
  }
  flush();
  return out;
}

function kvBlock(text) {
  if (!text) return {};
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([A-Z][A-Za-z /\-#]*?)\s*:\s*(.+)$/);
    if (m) {
      const key = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
      out[key] = m[2].trim();
    } else {
      out._freeText = (out._freeText || []).concat([line]);
    }
  }
  return out;
}

function parseValue(s) {
  if (!s) return 0;
  const cleaned = String(s).replace(/[^0-9.]/g, '');
  if (!cleaned) return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parsePhone(s) {
  if (!s) return { number: '', type: '', carrier: '' };
  const m = s.match(/^([0-9().\-\s+]+?)(?:\s*\((.+)\))?$/);
  if (!m) return { number: s, type: '', carrier: '' };
  const number = m[1].trim();
  const inner = (m[2] || '').trim();
  let type = '', carrier = '';
  if (inner) {
    const parts = inner.split(/\s*-\s*/);
    type    = (parts[0] || '').trim();
    carrier = (parts.slice(1).join(' - ') || '').trim();
  }
  return { number, type, carrier };
}

function findIncidentNumber(body) {
  const m = body.match(/Incident\s+Number\s+(CN-\d{2}-\d{2}-\d{4,6})/i);
  return m ? m[1] : '';
}

function findIncidentType(body) {
  const m = body.match(/^(Theft of [A-Z][A-Za-z ]+|Recovery of [A-Z][A-Za-z ]+|Suspicious[A-Za-z ]+|Attempted [A-Z][A-Za-z ]+)\s*$/m);
  return m ? m[1].trim() : '';
}

function parseCargoSection(text) {
  const out = { description: '', quantity: '', value: '', valueNum: 0 };
  const lines = (text || '').split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^([A-Z][A-Za-z ]*?)\s*:\s*(.+)$/);
    if (m) {
      const k = m[1].toLowerCase();
      const v = m[2].trim();
      if (k === 'quantity')                 out.quantity = v;
      else if (k.startsWith('approximate')) { out.value = v; out.valueNum = parseValue(v); }
      else if (k === 'value')                { out.value = v; out.valueNum = parseValue(v); }
      else                                   out[k.replace(/\s+/g, '_')] = v;
    } else {
      out.description = out.description ? (out.description + ' ' + line) : line;
    }
  }
  return out;
}

// genId is injected so cargonet-main can use crypto and the test can use a stub.
function parseCargonetEmail(parsedMail, sourceFile, opts = {}) {
  const genId   = opts.genId   || (() => 'cn_test_' + Date.now());
  const baseDir = opts.baseDir || '';

  const subjectRaw = (parsedMail.subject || '').trim();
  const subject = subjectRaw.replace(/^\s*(Fw:|Fwd:|Re:)\s*/i, '').trim();
  const textBody = parsedMail.text || (parsedMail.html ? String(parsedMail.html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n') : '');
  const body = normalizeBody(textBody);

  const sm = subject.match(SUBJ_RE);
  const alertType    = sm ? sm[1].trim() : 'Alert';
  const subjectCity  = sm ? sm[2].trim() : '';
  const subjectState = sm ? sm[3].trim() : '';
  const subjectCargo = sm ? sm[4].trim() : '';

  const sections = extractSections(body);

  const driverBlocks = sections['Subject Driver Information'] || [];
  const drivers = driverBlocks.map(block => {
    const kv = kvBlock(block);
    const phone = parsePhone(kv['phone'] || '');
    return {
      alias:        kv['alias'] || '',
      name:         kv['name']  || '',
      phone:        phone.number,
      phoneType:    phone.type,
      phoneCarrier: phone.carrier,
      cdl:          kv["driver's license"] || kv['license'] || kv['cdl'] || '',
      cdlState:     kv['license state'] || '',
      raw:          block,
    };
  });

  const locKv = kvBlock((sections['Date - Time - Location'] || [''])[0]);
  const location = {
    date:         locKv['date']          || '',
    time:         locKv['time']          || '',
    address:      locKv['address']       || '',
    city:         locKv['city']          || '',
    state:        locKv['state']         || '',
    zip:          locKv['zip']           || locKv['zip code'] || '',
    businessName: locKv['business name'] || '',
  };

  const tractorKv = kvBlock((sections['Tractor Details'] || [''])[0]);
  const tractor = {
    make:       tractorKv['make']           || '',
    model:      tractorKv['model']          || '',
    year:       tractorKv['year']           || '',
    color:      tractorKv['color']          || '',
    plate:      tractorKv['license plate']  || tractorKv['plate'] || '',
    plateState: tractorKv['license state']  || '',
    vin:        tractorKv['vin']            || '',
  };
  const trailerKv = kvBlock((sections['Trailer Details'] || [''])[0]);
  const trailer = {
    make:       trailerKv['make']           || '',
    color:      trailerKv['color']          || '',
    plate:      trailerKv['license plate']  || trailerKv['plate'] || '',
    plateState: trailerKv['license state']  || '',
    vin:        trailerKv['vin']            || '',
  };

  const cargo = parseCargoSection((sections['Cargo Details'] || [''])[0]);

  const agencyKv = kvBlock((sections['Investigating Agency'] || [''])[0]);
  const agency = {
    pdName:       agencyKv['pd name']       || agencyKv['agency'] || '',
    pdPhone:      agencyKv['pd phone']      || agencyKv['phone']  || '',
    reportNumber: agencyKv['report number'] || agencyKv['case number'] || '',
  };

  const contactText = (sections['Contact Information'] || [''])[0] || '';
  const ccMatch = contactText.match(/(\d-\d{3}-\d{3}-\d{4})/);
  const incidentNumber = findIncidentNumber(body);
  const incidentDescription = ((sections['Incident Description'] || [''])[0] || '').trim();
  const incidentType = findIncidentType(body) || 'Theft of Cargo';

  // baseDir-relative source name handling for archive path normalization
  let sourceName = sourceFile || '';
  if (sourceName && baseDir && sourceName.startsWith(baseDir)) {
    sourceName = sourceName.slice(baseDir.length).replace(/^[\\/]+/, '');
  }

  return {
    id: genId(),
    sourceFile: sourceName,
    receivedAt: new Date().toISOString(),
    sentDate:   parsedMail.date ? new Date(parsedMail.date).toISOString() : null,
    sender:     (parsedMail.from && parsedMail.from.text) || '',
    read:       false,
    archived:   false,

    subject,
    alertType,
    subjectCity,
    subjectState,
    subjectCargo,

    incidentType,
    incidentNumber,
    incidentDescription,
    drivers,
    location,
    tractor,
    trailer,
    cargo,
    agency,
    contact: {
      commandCenter: ccMatch ? ccMatch[1] : '',
      raw:           contactText,
    },

    rawBody: body.slice(0, 20000),
  };
}

module.exports = {
  parseCargonetEmail,
  // helpers exposed for tests
  normalizeBody,
  extractSections,
  kvBlock,
  parsePhone,
  parseValue,
  findIncidentNumber,
  findIncidentType,
  parseCargoSection,
  SUBJ_RE,
  SECTION_HEADERS,
};
