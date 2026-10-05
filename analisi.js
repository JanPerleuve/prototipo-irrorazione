/*
 * analisi.js: analisi indicativa delle foto delle cartine, nel browser (solo prototipo: la versione vera è la
 * Fase 2 della pipeline). Usata da Semplice.dc.html (rilievo semplice) e da Taratura.dc.html (raccolta dati per
 * tarare ritaglio e analisi su telefoni diversi), così le due pagine misurano esattamente lo stesso codice.
 * Va caricata prima di support.js: le costanti e le funzioni sono globali.
 */
// Cambia quando cambia l'analisi: finisce nei dati raccolti, per sapere con che versione sono state fatte le foto.
const ANALISI_VERSIONE = '2026-10-05';

const GUIDE = 0.7;          // lato del riquadro guida rispetto al lato del mirino (vedi .guide in CSS)
const MAX_SIDE = 640;       // lato massimo dell'immagine analizzata, in px
const FIND_YELLOW = 0.12;   // "giallo" minimo per distinguere la cartina dallo sfondo
const LEAF_GR = 1.15;       // verde/rosso oltre cui il pixel è foglia (la carta delle cartine sta sotto 1,11 nel 99% dei casi)
const LEAF_WIN = 0.03;      // lato della finestra per decidere se una zona è foglia, rispetto al lato dell'immagine
const LEAF_FRAC = 0.3;      // zona di foglia se almeno questa frazione dei pixel vicini è verde foglia
const STAIN_SPLIT = 0.5;    // soglia macchia = questa frazione del giallo tipico della cartina
const GLARE = 0.9;          // sotto questa frazione della luminosità della carta: macchia; sopra: riflesso
const EDGE_INSET = 0.04;    // margine tolto ai bordi della cartina (taglio a mano, ombre)
const CARD_SIDE = 480;      // la cartina trovata si ritaglia di nuovo dall'originale fino a questo lato, in px
// Graffetta: al massimo una per cartina. Si cerca una barra dritta di larghezza fissa che contenga
// "metallo" (grigio, chiaro o scuro) o "scuro non viola" più dei suoi due lati: un gruppo di macchie ha
// macchie anche ai lati e perde; una graffetta spezzata da un riflesso resta una barra. Se l'automatica
// sbaglia, si tocca la foto dove si trova la graffetta e la ricerca si fa solo lì intorno.
const CLIP_GREY = 0.3;      // (max−min)/max sotto questo valore: grigio, cioè metallo
const CLIP_DARK = 0.8;      // più scura di questa frazione della luminosità mediana della cartina
const CLIP_VIOLET = 10;     // blu − (rosso+verde)/2 non oltre questo valore: non è una macchia viola
const CLIP_GRID = 120;      // la ricerca si fa su una griglia ridotta di questo lato
const CLIP_LENS = [0.18, 0.28, 0.4];  // lunghezze provate, rispetto al lato (le graffette ne coprono il 25-50%)
const CLIP_WIDTH = 0.025;   // larghezza della barra, rispetto al lato
const CLIP_ANGLES = 18;     // inclinazioni provate su 180°
const CLIP_MIN_RESP = 0.35; // contrasto minimo dentro/fuori per dire "c'è una graffetta"
const CLIP_TAP_RESP = 0.12; // soglia più bassa quando la posizione l'ha indicata chi usa l'app
const CLIP_TAP_RADIUS = 0.12; // la ricerca guidata guarda entro questa distanza dal tocco, rispetto al lato
const CLIP_TAP_DISC = 0.05; // se lì non trova una barra, esclude un cerchio di questo raggio intorno al tocco
const CLIP_EDGE = 0.04;     // barre vicine al bordo e parallele al bordo: strisce di bordo, non graffette
const CLIP_BUFFER = 0.015;  // margine escluso intorno alla graffetta, rispetto al lato
// Stessa cartina due volte (vedi findDuplicate)
const SIG_GRID = 16;        // lato della griglia dell'impronta
const SIG_MIN_VALID = 0.4;  // cella valida se almeno questa frazione dei suoi pixel è cartina (non foglia né graffetta)
const SIG_MIN_SPREAD = 0.04; // impronta più piatta di così (cartina quasi pulita o tutta macchiata): solo il confronto esatto
const DUP_SIMILAR = 0.8;    // correlazione oltre cui due foto sembrano la stessa cartina

// Analisi indicativa nel browser, solo per il prototipo: la versione vera è la Fase 2 della pipeline.
// Provata sui ritagli del DB storico, su bianco e su foglie verdi simulate: il giallo delle cartine
// cambia molto tra i lotti (da verdino ad arancio), quindi la soglia si adatta alla cartina; le macchie
// sono blu-viola, i riflessi chiari. La foglia si riconosce per zona e non per pixel, perché alcuni
// pixel di una foglia verde-gialla somigliano alla carta.
function yellowness(r, g, b) {
  return (Math.min(r, g) - b) / Math.max(r, g, b, 1);
}

function isLeaf(r, g, b) {
  return g > LEAF_GR * Math.max(r, 1) && g > b;
}

function percentile(arr, p) {
  const s = Float32Array.from(arr).sort();
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
}

// Filtro a finestra quadrata su una maschera 0/1, con l'immagine integrale:
// test(pixel accesi nella finestra, pixel della finestra) decide il nuovo valore.
function boxFilter(m, w, h, rad, test) {
  const W = w + 1, sum = new Uint32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += m[y * w + x];
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + row;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - rad), y1 = Math.min(h, y + rad + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - rad), x1 = Math.min(w, x + rad + 1);
      const n = sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0];
      out[y * w + x] = test(n, (x1 - x0) * (y1 - y0)) ? 1 : 0;
    }
  }
  return out;
}
const dilate = (m, w, h, rad) => boxFilter(m, w, h, rad, (n) => n > 0);
const erode = (m, w, h, rad) => boxFilter(m, w, h, rad, (n, a) => n === a);

// 1 = sfondo foglia: zone in cui abbastanza pixel vicini sono verde foglia.
function leafZones(data, w, h) {
  const rad = Math.max(1, Math.floor(Math.max(w, h) * LEAF_WIN / 2));
  const m = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) m[k] = isLeaf(data[4 * k], data[4 * k + 1], data[4 * k + 2]) ? 1 : 0;
  return boxFilter(m, w, h, rad, (n, a) => n > LEAF_FRAC * a);
}

// "Indizio di graffetta" per pixel (0/1): metallo grigio oppure scuro e non viola, fuori dalle zone escluse.
function clipEvidence(px, bg, n) {
  const lumAll = [];
  for (let k = 0; k < n; k++) if (!bg[k]) lumAll.push(Math.max(px[4 * k], px[4 * k + 1], px[4 * k + 2]));
  const dark = CLIP_DARK * percentile(lumAll, 0.5);
  const e = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (bg[k]) continue;
    const r = px[4 * k], g = px[4 * k + 1], b = px[4 * k + 2], mx = Math.max(r, g, b);
    const grey = (mx - Math.min(r, g, b)) / Math.max(mx, 1) < CLIP_GREY;
    e[k] = grey || (mx < dark && b - (r + g) / 2 <= CLIP_VIOLET) ? 1 : 0;
  }
  return e;
}

// Barra: punti dentro (peso +) e due fasce ai lati (peso −), come scostamenti sulla griglia ridotta.
function barKernel(L, W, angle) {
  const ca = Math.cos(angle), sa = Math.sin(angle), R = Math.ceil(L / 2 + 2 * W + 1);
  const inner = [], outer = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
      if (Math.abs(u) > L / 2) continue;
      if (Math.abs(v) <= W / 2) inner.push([dx, dy]);
      else if (Math.abs(v) <= 1.5 * W + 1) outer.push([dx, dy]);
    }
  }
  return { inner: inner, outer: outer, horizontal: Math.abs(sa) < Math.sin(Math.PI / 9), vertical: Math.abs(ca) < Math.sin(Math.PI / 9) };
}
const BAR_KERNELS = [];
CLIP_LENS.forEach((lf) => {
  for (let a = 0; a < CLIP_ANGLES; a++) {
    const angle = a * Math.PI / CLIP_ANGLES;
    BAR_KERNELS.push(Object.assign({ lf: lf, angle: angle }, barKernel(lf * CLIP_GRID, Math.max(2, CLIP_WIDTH * CLIP_GRID), angle)));
  }
});

// Migliore barra sulla griglia ridotta. near: {x, y} in coordinate della griglia per la ricerca guidata.
function findBar(E, w, h, near) {
  const s = CLIP_GRID / Math.max(w, h), gw = Math.max(1, Math.round(w * s)), gh = Math.max(1, Math.round(h * s));
  // griglia ridotta: frazione di pixel "indizio" in ogni cella
  const G = new Float32Array(gw * gh), cnt = new Float32Array(gw * gh);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, Math.floor(y * s));
    for (let x = 0; x < w; x++) {
      const q = gy * gw + Math.min(gw - 1, Math.floor(x * s));
      G[q] += E[y * w + x]; cnt[q]++;
    }
  }
  for (let q = 0; q < G.length; q++) G[q] = cnt[q] ? G[q] / cnt[q] : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= gw || y >= gh ? 0 : G[y * gw + x]);
  const W = Math.max(2, CLIP_WIDTH * CLIP_GRID), edge = Math.floor(CLIP_EDGE * CLIP_GRID + W);
  const r2 = near ? (CLIP_TAP_RADIUS * CLIP_GRID) ** 2 : Infinity;
  let best = null;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (G[y * gw + x] < 0.2) continue;   // il centro di una graffetta è sulla graffetta
      if (near && (x - near.x) ** 2 + (y - near.y) ** 2 > r2) continue;
      for (const k of BAR_KERNELS) {
        if (!near && ((k.horizontal && (y < edge || y >= gh - edge)) || (k.vertical && (x < edge || x >= gw - edge)))) continue;
        let si = 0, so = 0;
        for (const [dx, dy] of k.inner) si += at(x + dx, y + dy);
        for (const [dx, dy] of k.outer) so += at(x + dx, y + dy);
        const resp = si / k.inner.length - so / k.outer.length;
        if (!best || resp > best.resp) best = { resp: resp, x: x / s, y: y / s, L: k.lf * Math.max(w, h), angle: k.angle };
      }
    }
  }
  return best;
}

// Maschera finale: indizi dentro il rettangolo della barra (un po' più largo), più il margine.
// La barra trovata ha una delle lunghezze provate: la si allunga lungo l'asse finché continua la graffetta.
function barMask(E, w, h, bar) {
  const side = Math.max(w, h), W = CLIP_WIDTH * side, ca = Math.cos(bar.angle), sa = Math.sin(bar.angle);
  const maxU = 0.6 * side, step = Math.max(1, W / 2), nb = Math.ceil(maxU / step);
  // per ogni tratto lungo l'asse: indizi sulla barra e ai suoi lati (un riflesso largo ce li ha anche ai lati)
  const inHit = new Float32Array(2 * nb + 1), inTot = new Float32Array(2 * nb + 1);
  const outHit = new Float32Array(2 * nb + 1), outTot = new Float32Array(2 * nb + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - bar.x, dy = y - bar.y, u = dx * ca + dy * sa, v = Math.abs(-dx * sa + dy * ca);
      if (Math.abs(u) > maxU || v > 2 * W) continue;
      const b = nb + Math.round(u / step);
      if (v <= 0.75 * W) { inHit[b] += E[y * w + x]; inTot[b]++; } else if (v > W) { outHit[b] += E[y * w + x]; outTot[b]++; }
    }
  }
  const on = (b) => inTot[b] > 0 && inHit[b] / inTot[b] - (outTot[b] ? outHit[b] / outTot[b] : 0) >= 0.25;
  const reach = (dir) => {   // fino a dove continua, tollerando un buco breve (riflesso)
    let b = nb + dir * Math.round(0.5 * bar.L / step), gap = 0, last = b;
    while (b > 0 && b < 2 * nb) {
      b += dir;
      if (on(b)) { last = b; gap = 0; } else if (++gap > 3) break;
    }
    return (last - nb) * step + dir * (step / 2 + 1.5 * W);   // + le punte piegate, più scure
  };
  const u1 = reach(-1), u2 = reach(1);
  const keep = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - bar.x, dy = y - bar.y, u = dx * ca + dy * sa;
      const v = Math.abs(-dx * sa + dy * ca);
      // tutta la barra (anche i riflessi al centro della graffetta) più gli indizi appena fuori
      if (u >= u1 && u <= u2 && (v <= 0.6 * W || (v <= 1.5 * W && E[y * w + x]))) keep[y * w + x] = 1;
    }
  }
  const buf = Math.max(1, Math.floor(Math.max(3, Math.floor(side * CLIP_BUFFER) | 1) / 2));
  return dilate(keep, w, h, buf);
}

// Graffetta automatica (tap = null) o guidata dal tocco (tap = {x, y} in pixel della cartina).
function clipZones(prep, tap) {
  const { cw, ch, E } = prep, side = Math.max(cw, ch), s = CLIP_GRID / side;
  if (!tap) {
    const bar = findBar(E, cw, ch, null);
    return bar && bar.resp >= CLIP_MIN_RESP ? barMask(E, cw, ch, bar) : new Uint8Array(cw * ch);
  }
  const bar = findBar(E, cw, ch, { x: tap.x * s, y: tap.y * s });
  if (bar && bar.resp >= CLIP_TAP_RESP) return barMask(E, cw, ch, bar);
  // nessuna barra riconoscibile: si esclude un cerchio intorno al tocco
  const out = new Uint8Array(cw * ch), r = CLIP_TAP_DISC * side;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if ((x - tap.x) ** 2 + (y - tap.y) ** 2 <= r * r) out[y * cw + x] = 1;
  return out;
}

// Rettangolo della cartina: righe e colonne con abbastanza pixel gialli fuori dalle zone di foglia.
function findPaper(data, leaf, w, h) {
  const cols = new Array(w).fill(0), rows = new Array(h).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x, i = 4 * k;
      if (!leaf[k] && yellowness(data[i], data[i + 1], data[i + 2]) > FIND_YELLOW) { cols[x]++; rows[y]++; }
    }
  }
  const span = (arr) => {
    const lim = Math.max.apply(null, arr) * 0.2;
    let a = arr.findIndex((v) => v > lim), b = arr.length - 1;
    while (b > a && arr[b] <= lim) b--;
    return [a, b];
  };
  const [x0, x1] = span(cols), [y0, y1] = span(rows);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (x0 < 0 || bw < w * 0.15 || bh < h * 0.15) return null;
  const ratio = bw / bh;
  if (ratio < 0.7 || ratio > 1.4) return null;
  const dx = Math.round(bw * EDGE_INSET), dy = Math.round(bh * EDGE_INSET);
  return { x: x0 + dx, y: y0 + dy, w: bw - 2 * dx, h: bh - 2 * dy };
}

const NOT_FOUND = 'Non trovo la cartina. Avvicinati, mettila al centro del riquadro e riprova.';

// src: video o immagine; region: parte di src da considerare, in px di src.
function analyzeCard(src, region) {
  const scale = Math.min(1, MAX_SIDE / Math.max(region.w, region.h));
  const w = Math.round(region.w * scale), h = Math.round(region.h * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, region.x, region.y, region.w, region.h, 0, 0, w, h);
  const full = ctx.getImageData(0, 0, w, h).data;
  const leaf = leafZones(full, w, h);

  const box = findPaper(full, leaf, w, h);
  if (!box) return { error: NOT_FOUND };

  // La cartina si è trovata sull'immagine ridotta; ora si ritaglia dall'originale, a risoluzione più alta:
  // a 640 px su tutta la foto la cartina resterebbe sui 190 px, troppo pochi per graffetta e gocce fini.
  const sw = box.w / scale, sh = box.h / scale;
  const cs = Math.min(1, CARD_SIDE / Math.max(sw, sh));
  const cw = Math.max(1, Math.round(sw * cs)), ch = Math.max(1, Math.round(sh * cs));
  const cc = document.createElement('canvas');
  cc.width = cw; cc.height = ch;
  const cctx = cc.getContext('2d', { willReadFrequently: true });
  cctx.drawImage(src, region.x + box.x / scale, region.y + box.y / scale, sw, sh, 0, 0, cw, ch);
  const crop = cctx.getImageData(0, 0, cw, ch);

  const n = cw * ch;
  const yel = new Float32Array(n), lum = new Float32Array(n), bg = new Uint8Array(n);
  for (let yy = 0; yy < ch; yy++) {
    for (let xx = 0; xx < cw; xx++) {
      const k = yy * cw + xx;
      const r = crop.data[4 * k], g = crop.data[4 * k + 1], b = crop.data[4 * k + 2];
      yel[k] = yellowness(r, g, b);
      lum[k] = Math.max(r, g, b);
      // zone di foglia: dalla mappa a bassa risoluzione, al pixel più vicino
      bg[k] = leaf[(box.y + Math.floor(yy * box.h / ch)) * w + box.x + Math.floor(xx * box.w / cw)];
    }
  }
  if (n - bg.reduce((a, v) => a + v, 0) < 0.3 * n) return { error: NOT_FOUND };
  let hash = 2166136261;   // FNV-1a su un pixel ogni 7: stesso file caricato due volte, stessi pixel
  for (let k = 0; k < crop.data.length; k += 28) { hash ^= crop.data[k] ^ (crop.data[k + 1] << 8) ^ (crop.data[k + 2] << 16); hash = Math.imul(hash, 16777619); }
  const prep = { crop: crop, cw: cw, ch: ch, yel: yel, lum: lum, leaf: bg, E: clipEvidence(crop.data, bg, n),
    hash: cw + 'x' + ch + ':' + (hash >>> 0).toString(36) };
  // box: dove è stata trovata la cartina, in pixel dell'immagine originale (per la taratura del ritaglio)
  const found = { x: Math.round(region.x + box.x / scale), y: Math.round(region.y + box.y / scale), w: Math.round(sw), h: Math.round(sh) };
  return { prep: prep, result: cardResult(prep, clipZones(prep, null)), box: found };
}

// Copertura con la graffetta indicata (clip: maschera 0/1), maschera e foto con la graffetta in arancio.
function cardResult(prep, clip) {
  const { cw, ch, yel, lum } = prep, n = cw * ch;
  const crop = new ImageData(new Uint8ClampedArray(prep.crop.data), cw, ch);
  const bg = Uint8Array.from(prep.leaf);
  let clipCount = 0;
  for (let k = 0; k < n; k++) if (clip[k] && !bg[k]) { clipCount++; bg[k] = 2; }
  const card = (arr) => arr.filter((v, k) => !bg[k]);
  const valid = n - bg.reduce((a, v) => a + (v ? 1 : 0), 0);
  const split = STAIN_SPLIT * percentile(card(yel), 0.85);
  const paperLum = percentile(lum.filter((v, k) => !bg[k] && yel[k] > split), 0.5) || 255;

  const mask = new ImageData(cw, ch);
  const mk = mask.data;
  let stain = 0;
  const gValid = new Float32Array(SIG_GRID * SIG_GRID), gStain = new Float32Array(SIG_GRID * SIG_GRID);
  for (let k = 0; k < n; k++) {
    const g = Math.min(SIG_GRID - 1, Math.floor((k / cw | 0) * SIG_GRID / ch)) * SIG_GRID + Math.min(SIG_GRID - 1, Math.floor((k % cw) * SIG_GRID / cw));
    let rgb = [255, 255, 255];
    if (bg[k] === 1) rgb = [190, 214, 178];
    else if (bg[k] === 2) {
      rgb = [224, 123, 36];
      // sulla foto: tinta arancio sopra la graffetta
      for (let c = 0; c < 3; c++) crop.data[4 * k + c] = Math.round(0.45 * crop.data[4 * k + c] + 0.55 * rgb[c]);
    } else if (yel[k] <= split && lum[k] < GLARE * paperLum) { stain++; rgb = [35, 35, 35]; gStain[g]++; }
    if (!bg[k]) gValid[g]++;
    mk[4 * k] = rgb[0]; mk[4 * k + 1] = rgb[1]; mk[4 * k + 2] = rgb[2]; mk[4 * k + 3] = 255;
  }

  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  const octx = out.getContext('2d');
  octx.putImageData(crop, 0, 0);
  const cropUrl = out.toDataURL('image/jpeg', 0.9);
  octx.putImageData(mask, 0, 0);
  const maskUrl = out.toDataURL('image/png');

  const cell = n / (SIG_GRID * SIG_GRID);
  const sig = Array.from(gValid, (v, g) => (v < SIG_MIN_VALID * cell ? '-' : Math.min(35, Math.round(35 * gStain[g] / v)).toString(36))).join('');
  return { coverage: 100 * stain / valid, clipFrac: 100 * clipCount / n, cropUrl: cropUrl, maskUrl: maskUrl, sig: sig, hash: prep.hash };
}

// ---- Stessa cartina due volte ----
// Impronta: densità delle macchie in una griglia SIG_GRID × SIG_GRID ('0'…'z', '-' = zona esclusa, foglia o graffetta).
// Due foto della stessa cartina hanno le macchie negli stessi punti, anche su sfondi diversi e girate di 90°.
// Cartine quasi pulite o quasi tutte macchiate hanno un'impronta quasi piatta: per quelle si confronta solo
// l'immagine identica, perché si somigliano tutte (e comunque l'avviso lascia sempre proseguire).
function sigValues(sig) {
  return Array.from(sig, (ch) => (ch === '-' ? null : parseInt(ch, 36) / 35));
}
// Media 3×3 sulle celle valide: tollera piccoli spostamenti del ritaglio tra una foto e l'altra.
function sigSmooth(v) {
  const G = SIG_GRID, out = new Array(G * G).fill(null);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
    if (v[y * G + x] == null) continue;
    let a = 0, m = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy < 0 || xx < 0 || yy >= G || xx >= G || v[yy * G + xx] == null) continue;
      a += v[yy * G + xx]; m++;
    }
    out[y * G + x] = a / m;
  }
  return out;
}
function sigRotate(v) {   // 90° in senso orario
  const G = SIG_GRID, out = new Array(G * G);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) out[x * G + (G - 1 - y)] = v[y * G + x];
  return out;
}
function sigSpread(v) {
  const ok = v.filter((x) => x != null), m = ok.reduce((a, x) => a + x, 0) / Math.max(1, ok.length);
  return Math.sqrt(ok.reduce((a, x) => a + (x - m) * (x - m), 0) / Math.max(1, ok.length));
}
// Somiglianza tra due impronte: la correlazione migliore tra le 4 rotazioni (−1…1), null se non si può dire.
function sigSimilarity(a, b) {
  if (!a || !b) return null;
  const va = sigSmooth(sigValues(a));
  let vb = sigSmooth(sigValues(b)), best = null;
  if (sigSpread(va) < SIG_MIN_SPREAD || sigSpread(vb) < SIG_MIN_SPREAD) return null;
  for (let r = 0; r < 4; r++, vb = sigRotate(vb)) {
    const idx = [];
    for (let k = 0; k < va.length; k++) if (va[k] != null && vb[k] != null) idx.push(k);
    if (idx.length < 0.5 * va.length) continue;
    const ma = idx.reduce((s, k) => s + va[k], 0) / idx.length, mb = idx.reduce((s, k) => s + vb[k], 0) / idx.length;
    let sab = 0, saa = 0, sbb = 0;
    idx.forEach((k) => { const da = va[k] - ma, db = vb[k] - mb; sab += da * db; saa += da * da; sbb += db * db; });
    const corr = saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
    if (best == null || corr > best) best = corr;
  }
  return best;
}
// La cartina già presente che somiglia di più a questa: { id, kind: 'same' (stessa immagine) | 'similar' }, o null.
function findDuplicate(card, others) {
  let found = null;
  others.forEach((o) => {
    if (o.id === card.id) return;
    if (card.hash && o.hash === card.hash) { found = { id: o.id, kind: 'same', score: 1 }; return; }
    if (found && found.kind === 'same') return;
    const sim = sigSimilarity(card.sig, o.sig);
    if (sim != null && sim >= DUP_SIMILAR && (!found || sim > found.score)) found = { id: o.id, kind: 'similar', score: sim };
  });
  return found ? Object.assign(found, { ok: false }) : null;
}

// Parametri dell'analisi, salvati con i dati di taratura.
const ANALISI_PARAMETRI = { GUIDE, MAX_SIDE, FIND_YELLOW, LEAF_GR, LEAF_WIN, LEAF_FRAC, STAIN_SPLIT, GLARE, EDGE_INSET, CARD_SIDE,
  CLIP_GREY, CLIP_DARK, CLIP_VIOLET, CLIP_GRID, CLIP_LENS, CLIP_WIDTH, CLIP_ANGLES, CLIP_MIN_RESP, CLIP_TAP_RESP, CLIP_TAP_RADIUS,
  CLIP_TAP_DISC, CLIP_EDGE, CLIP_BUFFER, SIG_GRID, SIG_MIN_VALID, SIG_MIN_SPREAD, DUP_SIMILAR };
