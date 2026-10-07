/*
 * schede.js: le schede standard del rilievo accurato nel prototipo (numeri, collegamento al rilievo, PDF, QR).
 * Va caricata dopo qrcode.js e jsQR.js e prima di support.js: le funzioni sono globali.
 *
 * Regole (decise il 07/10/2026, vedi CLAUDE.md; sulla scheda non sono scritte, stanno nell'app):
 *  - i numeri delle schede sono unici e li assegna il server, a blocchi per cliente; ogni lotto si genera prima del
 *    rilievo e il suo PDF si scarica una volta sola; l'app dice di stamparla una volta sola, senza fotocopie;
 *  - una scheda vale per un solo rilievo: se è già collegata a un altro l'app lo segnala; se l'operatore deve
 *    proprio usarla, si salva con un identificativo distinto (ESE-0042 → ESE-0042-2) e i dati non si mescolano;
 *  - al caricamento il QR della foto deve coincidere con il numero collegato; se non coincide l'app avvisa e
 *    l'operatore può confermare lo stesso (la conferma resta con la foto); il numero si può sempre scrivere a mano.
 *
 * Nel prototipo il "server" è il localStorage di questo browser (SCHEDE_KEY): l'unicità vale solo su questo
 * telefono. Con il backend, nuovoLotto() e collegaScheda() diventano chiamate al server.
 */
const SCHEDE_KEY = 'perleuve.schede';
const SCHEDE_PREFISSO = 'ESE';     // codice del cliente dell'account (nel prodotto viene dal server)
const SCHEDE_RIGHE = 5;            // righe della scheda = repliche; con più repliche servono più schede per parete

function schedeRegistro() {
  try {
    const r = JSON.parse(localStorage.getItem(SCHEDE_KEY) || 'null');
    if (r && r.prossimo) return r;
  } catch (e) { /* registro rovinato: si riparte */ }
  return { prefisso: SCHEDE_PREFISSO, prossimo: 1, lotti: [], usi: {} };
}
function schedeSalva(r) {
  try { localStorage.setItem(SCHEDE_KEY, JSON.stringify(r)); return true; } catch (e) { return false; }
}
const numeroScheda = (prefisso, n) => prefisso + '-' + String(n).padStart(4, '0');

// Numero scritto a mano o letto dal QR → forma normale (ESE-0042, ESE-0042-2); '' se non sembra un numero di scheda.
function normalizzaNumero(t) {
  const m = String(t || '').toUpperCase().replace(/\s+/g, '').match(/^([A-Z]{2,5})-?(\d{1,6})(?:-(\d{1,2}))?$/);
  if (!m) return '';
  return m[1] + '-' + m[2].padStart(4, '0') + (m[3] ? '-' + parseInt(m[3], 10) : '');
}
// Il numero stampato sulla scheda (senza il suffisso del riuso).
const numeroBase = (id) => String(id || '').replace(/-\d{1,2}$/, '').replace(/^([A-Z]{2,5}-\d{4,6}).*$/, '$1');

// Nuovo lotto di n schede con numeri mai usati; il lotto risulta già scaricato (il PDF si scarica una volta).
function nuovoLotto(n) {
  const r = schedeRegistro(), da = r.prossimo;
  const numeri = Array.from({ length: n }, (_, i) => numeroScheda(r.prefisso, da + i));
  r.prossimo = da + n;
  const lotto = { id: 'L' + (r.lotti.length + 1), numeri: numeri, creato: new Date().toISOString(), scaricato: true };
  r.lotti.push(lotto);
  schedeSalva(r);
  return lotto;
}

// Usi di una scheda (per numero stampato): [{ id, rilievo, parete, quando }].
function usiScheda(numero) {
  return (schedeRegistro().usi[numeroBase(numero)] || []).slice();
}

// Collega una scheda a un rilievo. Se è già collegata a un altro rilievo restituisce { conflitto, usi };
// con forza = true la collega lo stesso con un identificativo nuovo (ESE-0042-2…).
function collegaScheda(numero, rilievo, parete, forza) {
  const base = numeroBase(normalizzaNumero(numero));
  if (!base) return { errore: 'numero non valido' };
  const r = schedeRegistro(), usi = r.usi[base] || [];
  const mio = usi.find((u) => u.rilievo === rilievo && u.parete === parete);
  if (mio) return { id: mio.id };
  const altri = usi.filter((u) => u.rilievo !== rilievo);
  if (altri.length && !forza) return { conflitto: true, usi: altri };
  // suffisso nuovo: uno più del più alto già usato (la prima scheda vale 1), anche se nel frattempo un uso è stato tolto
  const top = usi.reduce((m, u) => Math.max(m, u.id === base ? 1 : parseInt(u.id.slice(base.length + 1), 10) || 1), 0);
  const id = top ? base + '-' + (top + 1) : base;
  usi.push({ id: id, rilievo: rilievo, parete: parete, quando: new Date().toISOString() });
  r.usi[base] = usi;
  schedeSalva(r);
  return { id: id, riusata: usi.length > 1 };
}
function scollegaScheda(id, rilievo) {
  const base = numeroBase(id), r = schedeRegistro();
  r.usi[base] = (r.usi[base] || []).filter((u) => !(u.id === id && u.rilievo === rilievo));
  if (!r.usi[base].length) delete r.usi[base];
  schedeSalva(r);
}

// ---- QR della scheda in una foto o scansione ----
// Prima il lettore del browser (BarcodeDetector, su Android), poi jsQR su copie ridotte dell'immagine.
function leggiQrScheda(file) {
  const fromBitmap = (src, w, h) => {
    const tries = [1600, 2400, 1000];
    for (const side of tries) {
      const s = Math.min(1, side / Math.max(w, h)), cw = Math.round(w * s), ch = Math.round(h * s);
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(src, 0, 0, cw, ch);
      const res = typeof jsQR === 'function' ? jsQR(ctx.getImageData(0, 0, cw, ch).data, cw, ch, { inversionAttempts: 'dontInvert' }) : null;
      if (res && res.data) return res.data;
      if (s === 1) break;
    }
    return '';
  };
  return new Promise((resolve) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      const viaJs = () => { const t = fromBitmap(img, w, h); URL.revokeObjectURL(url); resolve({ testo: t, numero: normalizzaNumero(t), metodo: t ? 'jsQR' : '', larghezza: w, altezza: h }); };
      if ('BarcodeDetector' in window) {
        new window.BarcodeDetector({ formats: ['qr_code'] }).detect(img).then((codes) => {
          const t = codes && codes[0] && codes[0].rawValue;
          if (t) { URL.revokeObjectURL(url); resolve({ testo: t, numero: normalizzaNumero(t), metodo: 'BarcodeDetector', larghezza: w, altezza: h }); } else viaJs();
        }).catch(viaJs);
      } else viaJs();
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve({ testo: '', numero: '', metodo: '', errore: 'immagine non leggibile' }); };
    img.src = url;
  });
}

// Miniatura JPEG di un'immagine: si conserva con il rilievo nel browser (le foto intere non ci stanno).
function miniaturaImmagine(file, lato) {
  lato = lato || 900;
  return new Promise((resolve) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, lato / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(''); };
    img.src = url;
  });
}

// ---- Controllo dell'immagine di una scheda collegata ({ numero, id, foto }) ----
// foto: { qr (letto), manuale (scritto a mano), confermata (conferma dell'operatore) }.
// Stato: 'nessuna' | 'illeggibile' | 'ok' | 'diverso' | 'confermata'.
function controlloFoto(sc) {
  const f = sc && sc.foto;
  if (!f) return { stato: 'nessuna' };
  if (f.esempio) return { stato: 'ok', visto: sc.numero, esempio: true };
  const visto = f.manuale || f.qr;
  if (!visto) return { stato: 'illeggibile' };
  if (numeroBase(visto) === sc.numero) return { stato: 'ok', visto: visto, manuale: !!f.manuale };
  return { stato: f.confermata ? 'confermata' : 'diverso', visto: visto, manuale: !!f.manuale };
}
// Frase per l'operatore e classe di stile (check-ok, check-warn, check-info).
function testoControllo(chk, sc) {
  if (chk.stato === 'ok' && chk.esempio) return { testo: 'Immagine già caricata (esempio).', cls: 'check-ok' };
  if (chk.stato === 'ok') return { testo: (chk.manuale ? 'Numero scritto a mano: ' : 'QR letto: ') + chk.visto + ', è la scheda collegata a questa parete.', cls: 'check-ok' };
  if (chk.stato === 'illeggibile') return { testo: 'Non riesco a leggere il QR in questa foto: prova a scrivere qui sotto il numero che vedi sulla scheda.', cls: 'check-warn' };
  if (chk.stato === 'diverso') return { testo: 'Nella foto c’è la scheda ' + chk.visto + ', ma a questa parete è collegata la ' + sc.numero + ': prova a controllare. Se è la foto giusta, puoi usarla lo stesso.', cls: 'check-warn' };
  if (chk.stato === 'confermata') return { testo: 'Foto confermata a mano: nella foto c’è la scheda ' + chk.visto + ', a questa parete è collegata la ' + sc.numero + '. Lo annotiamo con il rilievo.', cls: 'check-info' };
  return { testo: '', cls: 'check-info' };
}
const fotoInOrdine = (sc) => ['ok', 'confermata'].indexOf(controlloFoto(sc).stato) !== -1;

// ---- Rilievi accurati inviati (archivio di prova nel browser; con il backend li tiene il server) ----
// { id, data, azienda, vigneto, descrizione, tipo, pareti, repliche, bbch, velocita, pressione, litriHa, miscela,
//   stato: 'foto' | 'elab' | 'done', schede: [{ key, title, numero, id, foto: { nome, thumb, qr, manuale, confermata } | null }] }
const RILIEVI_ACC_KEY = 'perleuve.rilieviAccurati';
function rilieviAccurati() {
  try { return JSON.parse(localStorage.getItem(RILIEVI_ACC_KEY) || '[]'); } catch (e) { return []; }
}
function salvaRilieviAccurati(list) {
  try { localStorage.setItem(RILIEVI_ACC_KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
}
// Aggiunge o sostituisce un rilievo (per id); false se lo spazio del browser è pieno.
function salvaRilievoAccurato(rec) {
  return salvaRilieviAccurati([rec].concat(rilieviAccurati().filter((r) => r.id !== rec.id)));
}

// ---- PDF delle schede ----
// Stessa scheda di tools/genera_scheda.py (stesse misure in mm: tools/analisi_schede.py la riconosce), disegnata
// con i caratteri standard del PDF (Helvetica) invece di Montserrat e Barlow. Una scheda per pagina, A4 orizzontale.
const SCH = (() => {
  const PAGE_W = 297, PAGE_H = 210, MARGIN = 8, MARKER = 12, CARD = 25, SLOT = 27, GAP = 2, ROWS = 5, COLS = 8, LABEL_W = 36, GRID_TOP = 44, QR = 24;
  const PITCH = SLOT + GAP, GRID_W = LABEL_W + COLS * PITCH - GAP, GRID_X = (PAGE_W - GRID_W) / 2;
  return { PAGE_W, PAGE_H, MARGIN, MARKER, CARD, SLOT, GAP, ROWS, COLS, LABEL_W, GRID_TOP, QR, PITCH, GRID_X, SLOT_X0: GRID_X + LABEL_W,
    POSIZIONI: [['AES', 'esterna · sopra'], ['AEI', 'esterna · sotto'], ['AIS', 'interna · sopra'], ['AII', 'interna · sotto'],
      ['BES', 'esterna · sopra'], ['BEI', 'esterna · sotto'], ['BIS', 'interna · sopra'], ['BII', 'interna · sotto']] };
})();
// Marcatori ArUco DICT_4X4_50, id 0–3, 6 × 6 celle con il bordo (1 = nero), come cv2.aruco.generateImageMarker.
const ARUCO = [
  ['111111', '101001', '110101', '111001', '111011', '111111'],
  ['111111', '111111', '100001', '101101', '101011', '111111'],
  ['111111', '111001', '111001', '111011', '100101', '111111'],
  ['111111', '101101', '101101', '110111', '110011', '111111']];
// In bianco e nero e senza testi di regole (decisi il 07/10/2026): le regole stanno nell'app.
const COL = { INK: [35, 31, 32], SOFT: [94, 88, 86], LINE: [185, 178, 174], GUIDE: [217, 211, 207] };
// Larghezze dei caratteri Helvetica e Helvetica-Bold (1/1000 em), da 32 a 126, per allineare il testo.
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELVB = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
// Caratteri non ASCII usati sulla scheda → codice WinAnsi e carattere ASCII di larghezza simile.
const WINANSI = { 'à': [0xE0, 'a'], 'è': [0xE8, 'e'], 'é': [0xE9, 'e'], 'ì': [0xEC, 'i'], 'ò': [0xF2, 'o'], 'ù': [0xF9, 'u'], '’': [0x92, "'"], '“': [0x93, '"'], '”': [0x94, '"'], '·': [0xB7, '.'], '×': [0xD7, '+'], '…': [0x85, 'm'] };

function pdfTextWidth(text, bold, size) {
  const w = bold ? HELVB : HELV;
  let s = 0;
  for (const ch of text) { const c = (WINANSI[ch] ? WINANSI[ch][1] : ch).charCodeAt(0); s += w[c - 32] || 556; }
  return s * size / 1000;
}
function pdfString(text) {
  let out = '(';
  for (const ch of text) {
    if (WINANSI[ch]) out += '\\' + WINANSI[ch][0].toString(8).padStart(3, '0');
    else if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (ch.charCodeAt(0) < 128) out += ch;
    else out += '?';
  }
  return out + ')';
}

// Contenuto di una pagina (operatori PDF) per la scheda con numero serial.
function paginaScheda(serial) {
  const k = 72 / 25.4, H = SCH.PAGE_H, f = (v) => (Math.round(v * 1000) / 1000).toString();
  const X = (x) => f(x * k), Y = (y) => f((H - y) * k), ops = [];
  const fill = (c) => ops.push((c[0] / 255).toFixed(3) + ' ' + (c[1] / 255).toFixed(3) + ' ' + (c[2] / 255).toFixed(3) + ' rg');
  const stroke = (c, w) => ops.push((c[0] / 255).toFixed(3) + ' ' + (c[1] / 255).toFixed(3) + ' ' + (c[2] / 255).toFixed(3) + ' RG ' + f(w * k) + ' w');
  const rect = (x, y, w, h) => ops.push(X(x) + ' ' + Y(y + h) + ' ' + f(w * k) + ' ' + f(h * k) + ' re f');
  const line = (x1, y1, x2, y2) => ops.push(X(x1) + ' ' + Y(y1) + ' m ' + X(x2) + ' ' + Y(y2) + ' l S');
  const rrect = (x, y, w, h, r) => {   // rettangolo con gli angoli arrotondati, solo il contorno
    const c = 0.5523 * r;
    ops.push([X(x + r) + ' ' + Y(y) + ' m', X(x + w - r) + ' ' + Y(y) + ' l',
      X(x + w - r + c) + ' ' + Y(y) + ' ' + X(x + w) + ' ' + Y(y + r - c) + ' ' + X(x + w) + ' ' + Y(y + r) + ' c',
      X(x + w) + ' ' + Y(y + h - r) + ' l', X(x + w) + ' ' + Y(y + h - r + c) + ' ' + X(x + w - r + c) + ' ' + Y(y + h) + ' ' + X(x + w - r) + ' ' + Y(y + h) + ' c',
      X(x + r) + ' ' + Y(y + h) + ' l', X(x + r - c) + ' ' + Y(y + h) + ' ' + X(x) + ' ' + Y(y + h - r + c) + ' ' + X(x) + ' ' + Y(y + h - r) + ' c',
      X(x) + ' ' + Y(y + r) + ' l', X(x) + ' ' + Y(y + r - c) + ' ' + X(x + r - c) + ' ' + Y(y) + ' ' + X(x + r) + ' ' + Y(y) + ' c', 'S'].join(' '));
  };
  const text = (x, y, s, size, bold, color, anchor) => {
    const w = pdfTextWidth(s, bold, size);
    const x0 = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x;
    fill(color);
    ops.push('BT /' + (bold ? 'F2' : 'F1') + ' ' + f(size * k) + ' Tf ' + X(x0) + ' ' + Y(y) + ' Td ' + pdfString(s) + ' Tj ET');
  };
  const matrix = (rows, x, y, size) => {   // matrice di celle (true = nero), unendo le celle nere vicine sulla riga
    const n = rows.length, cell = size / n;
    fill(COL.INK);
    rows.forEach((row, r) => {
      for (let c = 0; c < n;) {
        if (!row[c]) { c++; continue; }
        const c0 = c;
        while (c < n && row[c]) c++;
        rect(x + c0 * cell, y + r * cell, (c - c0) * cell + 0.01, cell + 0.01);
      }
    });
  };
  const { MARGIN, MARKER, QR, PAGE_W, PAGE_H, GRID_TOP, GRID_X, SLOT_X0, PITCH, SLOT, GAP, CARD, LABEL_W } = SCH;
  // marcatori agli angoli
  const right = PAGE_W - MARGIN - MARKER, bottom = PAGE_H - MARGIN - MARKER;
  [[MARGIN, MARGIN], [right, MARGIN], [right, bottom], [MARGIN, bottom]].forEach(([x, y], i) =>
    matrix(ARUCO[i].map((r) => Array.from(r, (b) => b === '1')), x, y, MARKER));
  // intestazione
  const tx = MARGIN + MARKER + 6;
  text(tx, MARGIN + 3.6, 'PERLEUVE', 3, true, COL.INK);
  text(tx, MARGIN + 11, 'Scheda cartine idrosensibili', 6, true, COL.INK);
  [['Parete', tx, tx + 80, 13], ['Data', tx + 92, tx + 140, 9]].forEach(([lab, x0, x1, off]) => {
    text(x0, MARGIN + 18.5, lab, 3.6, false, COL.INK);
    stroke(COL.LINE, 0.3); line(x0 + off, MARGIN + 19.1, x1, MARGIN + 19.1);
  });
  // QR con il numero (versione automatica, correzione L, 2 moduli di margine come in genera_scheda.py)
  const qx = right - 4 - QR, q = qrcode(0, 'L');
  q.addData(serial); q.make();
  const nq = q.getModuleCount(), cells = [];
  for (let r = -2; r < nq + 2; r++) { const row = []; for (let c = -2; c < nq + 2; c++) row.push(r >= 0 && c >= 0 && r < nq && c < nq && q.isDark(r, c)); cells.push(row); }
  matrix(cells, qx, MARGIN - 1, QR);
  text(qx - 3, MARGIN + 9, 'Scheda n.', 3, false, COL.SOFT, 'end');
  text(qx - 3, MARGIN + 17, serial, 7, true, COL.INK, 'end');
  // intestazioni delle colonne: solo il codice della posizione (le spiegazioni sono nell'app)
  SCH.POSIZIONI.forEach(([code], c) => text(SLOT_X0 + c * PITCH + SLOT / 2, GRID_TOP - 2.5, code, 3.8, true, COL.INK, 'middle'));
  // righe = repliche, con i posti
  for (let r = 0; r < SCH.ROWS; r++) {
    const y = GRID_TOP + r * PITCH;
    stroke(COL.LINE, 0.3); rrect(GRID_X, y, LABEL_W - 3, SLOT, 1.5);
    text(GRID_X + 3, y + 7, 'Replica', 3, false, COL.SOFT);
    text(GRID_X + 3, y + 19, String(r + 1), 10, true, COL.INK);
    for (let c = 0; c < SCH.COLS; c++) {
      const sx = SLOT_X0 + c * PITCH;
      stroke(COL.LINE, 0.3); rrect(sx, y, SLOT, SLOT, 0.8);
      stroke(COL.GUIDE, 0.35);
      const cx = sx + SLOT / 2, cy = y + SLOT / 2, h = CARD / 2;
      [-1, 1].forEach((sx2) => [-1, 1].forEach((sy2) => {
        const x0 = cx + sx2 * h, y0 = cy + sy2 * h;
        line(x0, y0, x0 - sx2 * 3, y0); line(x0, y0, x0, y0 - sy2 * 3);
      }));
    }
  }
  // piè di pagina: 10 cm e regole di stampa
  const fy = PAGE_H - MARGIN - 6, lx0 = MARGIN + MARKER + 8;
  stroke(COL.INK, 0.4); line(lx0, fy, lx0 + 100, fy);
  stroke(COL.INK, 0.3);
  for (let i = 0; i <= 10; i++) line(lx0 + i * 10, fy - (i % 5 ? 2 : 3), lx0 + i * 10, fy);
  text(lx0, fy + 4.2, '10 cm', 2.8, false, COL.SOFT);
  return ops.join('\n');
}

// PDF con una scheda per pagina: un Blob da scaricare.
function pdfSchede(serials) {
  const W = (SCH.PAGE_W * 72 / 25.4).toFixed(2), H = (SCH.PAGE_H * 72 / 25.4).toFixed(2);
  const objs = [];   // stringhe degli oggetti, numerati da 1
  const add = (s) => { objs.push(s); return objs.length; };
  const catalog = add(''), pages = add(''), f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = serials.map((s) => {
    const content = paginaScheda(s);
    const c = add('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream');
    return add('<< /Type /Page /Parent ' + pages + ' 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Resources << /Font << /F1 ' + f1 + ' 0 R /F2 ' + f2 + ' 0 R >> >> /Contents ' + c + ' 0 R >>');
  });
  objs[catalog - 1] = '<< /Type /Catalog /Pages ' + pages + ' 0 R >>';
  objs[pages - 1] = '<< /Type /Pages /Kids [' + kids.map((k) => k + ' 0 R').join(' ') + '] /Count ' + kids.length + ' >>';
  // il contenuto è solo ASCII (i caratteri accentati sono in ottale), quindi lunghezze in caratteri = byte
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = out.length;
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalog + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xFF;
  return new Blob([bytes], { type: 'application/pdf' });
}
