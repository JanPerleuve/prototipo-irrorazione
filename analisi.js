/*
 * analisi.js: analisi delle foto delle cartine nel browser. Usata da Semplice.dc.html (rilievo semplice) e da
 * Taratura.dc.html (prova in ufficio), così le due pagine misurano esattamente lo stesso codice.
 * Va caricata prima di support.js: le costanti e le funzioni sono globali.
 *
 * Segue lo stesso metodo di tools/analisi_cartine.py (Python con OpenCV, il riferimento: nel prodotto girerà sul
 * server, sulla foto originale); qui serve per la risposta immediata sul telefono, anche senza rete.
 * Verificato sulle foto della prova in ufficio (7 telefoni × 24 cartine): stessi numeri del Python entro pochi decimi.
 *   1. Fondo: colore mediano della cornice esterna del riquadro; se è chiaro e neutro (carta, tavolo) l'immagine si
 *      bilancia su quel colore, così con luce calda un fondo beige non sembra giallo. Su foglia non si bilancia.
 *   2. Cartina: pixel diversi dal fondo, cioè colorati (carta gialla, macchie blu-viola) o più scuri (macchie fitte),
 *      fuori dalle zone di foglia; uniti, con i buchi riempiti, si tiene la macchia più grande che sia un quadrilatero
 *      pieno. Se non viene, si riprova con soglie più severe (ombre del telefono attaccate alla cartina).
 *   3. Ritaglio raddrizzato con la prospettiva, dall'immagine a piena risoluzione, senza un margine ai bordi.
 *   4. Copertura frazionaria: v = ((R+G)/2 − B) / luminosità del fondo, con la luce della carta stimata zona per zona
 *      (ombre); un pixel a metà tra carta e macchia (goccia più piccola del pixel, foto sfocata) conta per metà.
 *      Si escludono foglia, riflessi, strisce di fondo lungo i bordi e la graffetta.
 */
// Cambia quando cambia l'analisi: finisce nei dati raccolti, per sapere con che versione sono state fatte le foto.
const ANALISI_VERSIONE = '2026-10-05-b';

const GUIDE = 0.7;          // lato del riquadro guida rispetto al lato del mirino (vedi .guide in CSS)
// Ritrovamento (come in tools/analisi_cartine.py)
const MAX_SIDE = 800;       // lato massimo dell'immagine su cui si cerca la cartina, in px
const BG_RING = 0.06;       // cornice esterna da cui si stima il colore del fondo, rispetto al lato
const BG_MAX_CHROMA = 0.3;  // fondo più colorato di così: non si bilancia (foglia, o cartina che riempie il riquadro)
const FIND_DIFF = [0.3, 0.36, 0.42, 0.5];   // differenza minima dal fondo per dire "cartina", in ordine di severità
const FIND_CLOSE = 0.012;   // chiusura della maschera della cartina (graffetta, riflessi), rispetto al lato
const CARD_FILL = 0.75;     // la macchia trovata deve riempire almeno questa frazione del suo rettangolo
const QUAD_MIN = 0.9;       // il quadrilatero dagli angoli dell'inviluppo vale se copre almeno questa frazione del rettangolo
const CARD_MIN = 0.15;      // lato minimo della cartina rispetto al lato del riquadro
const LEAF_GR = 1.15;       // verde/rosso oltre cui il pixel è foglia (la carta delle cartine sta sotto 1,11 nel 99% dei casi)
const LEAF_WIN = 0.03;      // lato della finestra per decidere se una zona è foglia, rispetto al lato dell'immagine
const LEAF_FRAC = 0.3;      // zona di foglia se almeno questa frazione dei pixel vicini è verde foglia
// Ritaglio
const EDGE_INSET = 0.04;    // margine tolto a ogni bordo della cartina (taglio a mano, ombre), rispetto al lato
const CARD_SIDE = 600;      // lato massimo del ritaglio, in px (non si ingrandisce mai)
// Copertura
const PAPER_MIN = 0.5;      // la carta non è meno gialla di così (cartine tutte macchiate, dove il "giallo" è oliva)
const STAIN_MAX = -0.1;     // le macchie non sono meno blu di così (cartine quasi pulite)
const STAIN_SURE = 0.005;   // macchie sicure almeno questa frazione della cartina per stimarne il valore tipico
const STAIN_TYPICAL = 0.25; // percentile delle macchie sicure preso come macchia piena (compromesso tra DB e telefoni)
const DEAD_ZONE = 0.08;     // sotto la carta di meno di così: rumore della carta, non macchia
const LOCAL_LIGHT = 0.12;   // la luce sulla carta si stima zona per zona (ombre): raggio rispetto al lato
const LIGHT_LIMITS = [0.5, 1.3];   // la luce locale resta entro questi limiti rispetto a quella media della carta
const STRIP_NEUTRAL = 0.15; // strisce senza colore lungo un bordo del ritaglio (fondo, un'altra cartina)...
const STRIP_SIZE = [0.25, 0.3];    // ...larghe al massimo e lunghe almeno questa frazione del lato...
const STRIP_DENSE = 0.6;    // ...e compatte: riempiono almeno questa frazione del loro riquadro (non la rete grigia delle cartine molto macchiate)
const GLARE_CHROMA = 0.15;  // riflessi e nastro: meno colorati di così...
const GLARE_LUM = 1.05;     // ...e più chiari della carta
// Graffetta automatica (al massimo una): il segmento dritto di pixel grigi, scuri o lucidi, più lungo.
// È ancora imprecisa: se sbaglia si tocca la foto dove si trova (ricerca guidata, vedi clipZones).
const STAPLE_GREY = 0.35;   // pixel poco colorati...
const STAPLE_DARK = 0.7;    // ...e più scuri di questa frazione della carta, oppure...
const STAPLE_SHINY = 1.0;   // ...più chiari della carta (metallo lucido)
const STAPLE_LEN = [0.12, 0.75];   // lunghezza rispetto al lato della cartina
const STAPLE_WIDTH = 0.03;  // i pixel stanno quasi tutti entro questa distanza dall'asse, rispetto al lato
const STAPLE_STRAIGHT = 0.75;      // frazione dei pixel vicini all'asse (le punte piegate restano fuori)
const STAPLE_FULL = 0.25;   // pixel / (lunghezza × 2 × STAPLE_WIDTH): una riga continua, non una nuvola di macchie
const STAPLE_BUFFER = 0.015;       // margine escluso intorno alla graffetta, rispetto al lato
// Graffetta indicata con un tocco: si cerca una barra dritta di larghezza fissa che contenga "metallo" (grigio,
// chiaro o scuro) o "scuro non viola" più dei suoi due lati, solo intorno al tocco.
const CLIP_GREY = 0.3;      // (max−min)/max sotto questo valore: grigio, cioè metallo
const CLIP_DARK = 0.8;      // più scura di questa frazione della luminosità mediana della cartina
const CLIP_VIOLET = 10;     // blu − (rosso+verde)/2 non oltre questo valore: non è una macchia viola
const CLIP_GRID = 120;      // la ricerca si fa su una griglia ridotta di questo lato
const CLIP_LENS = [0.18, 0.28, 0.4];  // lunghezze provate, rispetto al lato (le graffette ne coprono il 25-50%)
const CLIP_WIDTH = 0.025;   // larghezza della barra, rispetto al lato
const CLIP_ANGLES = 18;     // inclinazioni provate su 180°
const CLIP_TAP_RESP = 0.12; // contrasto minimo dentro/fuori per dire "c'è una graffetta" vicino al tocco
const CLIP_TAP_RADIUS = 0.12; // la ricerca guidata guarda entro questa distanza dal tocco, rispetto al lato
const CLIP_TAP_DISC = 0.05; // se lì non trova una barra, esclude un cerchio di questo raggio intorno al tocco
const CLIP_EDGE = 0.04;     // (ricerca guidata) bordo della griglia, rispetto al lato
const CLIP_BUFFER = 0.015;  // margine escluso intorno alla graffetta, rispetto al lato
// Stessa cartina due volte (vedi findDuplicate)
const SIG_GRID = 16;        // lato della griglia dell'impronta
const SIG_MIN_VALID = 0.4;  // cella valida se almeno questa frazione dei suoi pixel è cartina (non foglia né graffetta)
const SIG_MIN_SPREAD = 0.04; // impronta più piatta di così (cartina quasi pulita o tutta macchiata): solo il confronto esatto
const DUP_SIMILAR = 0.8;    // correlazione oltre cui due foto sembrano la stessa cartina

function percentile(arr, p) {
  const s = Float32Array.from(arr).sort();
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
}
// Valori di arr dove sel[k] è vero (sel: array 0/1 o funzione k → bool).
function pick(arr, sel) {
  const out = [];
  for (let k = 0; k < arr.length; k++) if (sel(k)) out.push(arr[k]);
  return out;
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
const closeMask = (m, w, h, rad) => erode(dilate(m, w, h, rad), w, h, rad);
// Dilatazione con un disco di raggio r (margine intorno alla graffetta).
function dilateDisc(m, w, h, r) {
  const out = new Uint8Array(w * h), offs = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) offs.push([dx, dy]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!m[y * w + x]) continue;
    for (const [dx, dy] of offs) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 1; }
  }
  return out;
}

// Media mobile su una finestra (2·rad+1)², solo sui pixel dentro l'immagine.
function boxBlur(src, w, h, rad) {
  const W = w + 1, sum = new Float64Array(W * (h + 1)), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) { row += src[y * w + x]; sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + row; }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - rad), y1 = Math.min(h, y + rad + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - rad), x1 = Math.min(w, x + rad + 1);
      out[y * w + x] = (sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}
// Sfocatura gaussiana approssimata con tre medie mobili (deviazione standard sigma, in px).
function gaussBlur(src, w, h, sigma) {
  const n = 3, wIdeal = Math.sqrt(12 * sigma * sigma / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  let out = src;
  for (let i = 0; i < n; i++) out = boxBlur(out, w, h, ((i < m ? wl : wl + 2) - 1) / 2);
  return out;
}

// Macchie connesse (8 vicini) di una maschera 0/1: etichette (−1 = fuori) e per ognuna area e riquadro.
function components(m, w, h) {
  const n = w * h, lab = new Int32Array(n).fill(-1), stack = new Int32Array(n), comps = [];
  for (let s = 0; s < n; s++) {
    if (!m[s] || lab[s] >= 0) continue;
    const id = comps.length, c = { id: id, area: 0, x0: w, y0: h, x1: 0, y1: 0 };
    let sp = 0; stack[sp++] = s; lab[s] = id;
    while (sp) {
      const k = stack[--sp], x = k % w, y = (k / w) | 0;
      c.area++;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (m[q] && lab[q] < 0) { lab[q] = id; stack[sp++] = q; }
        }
      }
    }
    comps.push(c);
  }
  return { lab: lab, comps: comps };
}

// ---- Ritrovamento della cartina ----
// 1 = zona di foglia verde: abbastanza pixel vicini con verde/rosso oltre LEAF_GR.
function leafZones(data, w, h) {
  const rad = Math.max(1, Math.floor(Math.max(w, h) * LEAF_WIN / 2));
  const m = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) { const r = data[4 * k], g = data[4 * k + 1], b = data[4 * k + 2]; m[k] = g > LEAF_GR * Math.max(r, 1) && g > b ? 1 : 0; }
  return boxFilter(m, w, h, rad, (n, a) => n > LEAF_FRAC * a);
}

// Colore del fondo dalla cornice: { gains, lum } per bilanciare, o null (fondo colorato o coperto di foglia).
function borderBalance(data, leaf, w, h) {
  const t = Math.max(2, Math.round(Math.min(w, h) * BG_RING)), R = [], G = [], B = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= t && x < w - t && y >= t && y < h - t) continue;
      const k = y * w + x;
      if (leaf[k]) continue;
      R.push(data[4 * k]); G.push(data[4 * k + 1]); B.push(data[4 * k + 2]);
    }
  }
  if (R.length < 0.5 * 2 * t * (w + h - 2 * t)) return null;
  const med = (a) => { const s = Float32Array.from(a).sort(), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
  const r = med(R), g = med(G), b = med(B), mx = Math.max(r, g, b);
  if (mx < 50 || (mx - Math.min(r, g, b)) / mx > BG_MAX_CHROMA) return null;
  const m = (r + g + b) / 3, clamp = (v) => Math.min(1.6, Math.max(0.6, v));
  const gains = [clamp(m / Math.max(r, 1)), clamp(m / Math.max(g, 1)), clamp(m / Math.max(b, 1))];
  return { gains: gains, lum: Math.max(r * gains[0], g * gains[1], b * gains[2]) };
}

// Inviluppo convesso (catena monotona) di punti [x, y].
function convexHull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
const polyArea = (p) => Math.abs(p.reduce((a, q, i) => { const r = p[(i + 1) % p.length]; return a + q[0] * r[1] - r[0] * q[1]; }, 0)) / 2;

// Rettangolo di area minima che contiene l'inviluppo: lati, area e i 4 angoli.
function minAreaRect(hull) {
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i], q = hull[(i + 1) % hull.length], a = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const ca = Math.cos(a), sa = Math.sin(a);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ca + y * sa, v = -x * sa + y * ca;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) {
      const pt = (u, v) => [u * ca - v * sa, u * sa + v * ca];
      best = { area: area, w: u1 - u0, h: v1 - v0, box: [pt(u0, v0), pt(u1, v0), pt(u1, v1), pt(u0, v1)] };
    }
  }
  return best;
}
// Angoli in ordine alto-sx, alto-dx, basso-dx, basso-sx.
function orderCorners(p) {
  const by = (f, mx) => p.reduce((b, q) => ((mx ? f(q) > f(b) : f(q) < f(b)) ? q : b));
  return [by((q) => q[0] + q[1], false), by((q) => q[1] - q[0], false), by((q) => q[0] + q[1], true), by((q) => q[1] - q[0], true)];
}

// La cartina con una soglia: angoli (in px dell'immagine ridotta) del quadrilatero pieno più grande, o il motivo.
function findCard(data, leaf, w, h, bgLum, diffMin) {
  const n = w * h, m = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (leaf[k]) continue;
    const r = data[4 * k], g = data[4 * k + 1], b = data[4 * k + 2], mx = Math.max(r, g, b);
    const diff = Math.max((mx - Math.min(r, g, b)) / Math.max(mx, 1), bgLum ? 1 - mx / bgLum : 0);
    if (mx > 25 && diff > diffMin) m[k] = 1;
  }
  const closed = closeMask(m, w, h, Math.max(1, Math.round(Math.min(w, h) * FIND_CLOSE)));
  const { lab, comps } = components(closed, w, h), side = Math.min(w, h);
  // area con i buchi riempiti: si conta il fuori, partendo dal bordo del riquadro della macchia
  const filledArea = (c) => {
    const bw = c.x1 - c.x0 + 3, bh = c.y1 - c.y0 + 3, out = new Uint8Array(bw * bh), stack = new Int32Array(bw * bh);
    const inside = (x, y) => x >= 1 && y >= 1 && x < bw - 1 && y < bh - 1 && lab[(c.y0 + y - 1) * w + c.x0 + x - 1] === c.id;
    let sp = 0, outside = 0; stack[sp++] = 0; out[0] = 1;
    while (sp) {
      const q = stack[--sp], x = q % bw, y = (q / bw) | 0; outside++;
      if (x > 0 && !out[q - 1] && !inside(x - 1, y)) { out[q - 1] = 1; stack[sp++] = q - 1; }
      if (x < bw - 1 && !out[q + 1] && !inside(x + 1, y)) { out[q + 1] = 1; stack[sp++] = q + 1; }
      if (y > 0 && !out[q - bw] && !inside(x, y - 1)) { out[q - bw] = 1; stack[sp++] = q - bw; }
      if (y < bh - 1 && !out[q + bw] && !inside(x, y + 1)) { out[q + bw] = 1; stack[sp++] = q + bw; }
    }
    return bw * bh - outside;
  };
  let reason = 'nessuna macchia abbastanza grande';
  for (const c of comps.sort((a, b) => b.area - a.area)) {
    if (c.area < 0.03 * n) break;
    const area = filledArea(c);
    const pts = [];
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
      const k = y * w + x;
      if (lab[k] !== c.id) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || lab[k - 1] !== c.id || lab[k + 1] !== c.id || lab[k - w] !== c.id || lab[k + w] !== c.id) pts.push([x, y]);
    }
    const hull = convexHull(pts), rect = minAreaRect(hull);
    if (!rect) continue;
    const lo = Math.min(rect.w, rect.h), hi = Math.max(rect.w, rect.h);
    if (lo < CARD_MIN * side) reason = 'piccola';
    else if (hi / Math.max(lo, 1) > 1.4) reason = 'non quadrata';
    else if (area < CARD_FILL * rect.area) reason = 'non piena';
    else if (c.x0 <= 0 || c.y0 <= 0 || c.x1 >= w - 1 || c.y1 >= h - 1) reason = 'tocca il bordo';
    else {
      // angoli: i punti dell'inviluppo più vicini agli angoli del rettangolo (seguono la prospettiva), se il
      // quadrilatero che formano copre quasi tutto il rettangolo; altrimenti il rettangolo
      const quad = rect.box.map((p) => hull.reduce((b, q) => ((q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < (b[0] - p[0]) ** 2 + (b[1] - p[1]) ** 2 ? q : b)));
      return { corners: orderCorners(polyArea(quad) > QUAD_MIN * rect.area ? quad : rect.box) };
    }
  }
  return { reason: reason };
}

// Omografia che porta i 4 punti src nei 4 punti dst (matrice 3×3 per righe).
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let c = 0; c < 8; c++) {   // eliminazione di Gauss con pivot
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = b.map((v, i) => v / A[i][i]);
  return [x[0], x[1], x[2], x[3], x[4], x[5], x[6], x[7], 1];
}
const applyH = (H, x, y) => { const d = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d]; };

// Ritaglio raddrizzato (cw × ch) della cartina dagli angoli in px di src, senza il margine ai bordi.
// Restituisce i pixel e l'omografia ritaglio → src.
function warpCard(src, corners) {
  const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]), [tl, tr, br, bl] = corners;
  const lw = (d(tr, tl) + d(br, bl)) / 2, lh = (d(bl, tl) + d(br, tr)) / 2, k = Math.min(1, CARD_SIDE / Math.max(lw, lh));
  const cw = Math.max(8, Math.round(lw * k)), ch = Math.max(8, Math.round(lh * k)), mw = EDGE_INSET * cw, mh = EDGE_INSET * ch;
  const H = homography([[-mw, -mh], [cw + mw, -mh], [cw + mw, ch + mh], [-mw, ch + mh]], corners);
  // pixel a piena risoluzione della zona della cartina
  const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
  const sw = src.videoWidth || src.naturalWidth || src.width, sh = src.videoHeight || src.naturalHeight || src.height;
  const X0 = Math.max(0, Math.floor(Math.min.apply(null, xs)) - 2), Y0 = Math.max(0, Math.floor(Math.min.apply(null, ys)) - 2);
  const X1 = Math.min(sw, Math.ceil(Math.max.apply(null, xs)) + 3), Y1 = Math.min(sh, Math.ceil(Math.max.apply(null, ys)) + 3);
  const SW = X1 - X0, SH = Y1 - Y0, c = document.createElement('canvas');
  c.width = SW; c.height = SH;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, X0, Y0, SW, SH, 0, 0, SW, SH);
  const S = ctx.getImageData(0, 0, SW, SH).data, out = new ImageData(cw, ch), o = out.data;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let [u, v] = applyH(H, x, y);
      u = Math.min(SW - 1, Math.max(0, u - X0)); v = Math.min(SH - 1, Math.max(0, v - Y0));   // bordi: si ripete l'ultimo pixel
      const u0 = Math.floor(u), v0 = Math.floor(v), u1 = Math.min(SW - 1, u0 + 1), v1 = Math.min(SH - 1, v0 + 1), fu = u - u0, fv = v - v0;
      const i00 = 4 * (v0 * SW + u0), i10 = 4 * (v0 * SW + u1), i01 = 4 * (v1 * SW + u0), i11 = 4 * (v1 * SW + u1), q = 4 * (y * cw + x);
      for (let c2 = 0; c2 < 3; c2++) o[q + c2] = (S[i00 + c2] * (1 - fu) + S[i10 + c2] * fu) * (1 - fv) + (S[i01 + c2] * (1 - fu) + S[i11 + c2] * fu) * fv;
      o[q + 3] = 255;
    }
  }
  return { crop: out, cw: cw, ch: ch, H: H };
}

// ---- Copertura ----
// Strisce senza colore lungo un bordo del ritaglio: fondo o un'altra cartina entrati nel riquadro. Si cercano lato
// per lato, dentro una fascia larga STRIP_SIZE[0], così una striscia resta tale anche se tocca altre zone grigie.
function borderStrips(sat, ok, w, h) {
  const m = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) m[k] = ok[k] && sat[k] < STRIP_NEUTRAL ? 1 : 0;
  const closed = closeMask(m, w, h, 1), out = new Uint8Array(w * h), [wide, long] = STRIP_SIZE;
  const bw = Math.max(1, Math.round(wide * w)), bh = Math.max(1, Math.round(wide * h));
  // fasce: [x0, y0, larghezza, altezza, lato che deve toccare]
  for (const [x0, y0, fw, fh, edge] of [[0, 0, bw, h, 'l'], [w - bw, 0, bw, h, 'r'], [0, 0, w, bh, 't'], [0, h - bh, w, bh, 'b']]) {
    const f = new Uint8Array(fw * fh);
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) f[y * fw + x] = closed[(y0 + y) * w + x0 + x];
    const { lab, comps } = components(f, fw, fh), keep = new Set();
    comps.forEach((c) => {
      if (c.area < 0.003 * w * h || c.area < STRIP_DENSE * (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1)) return;
      const touches = edge === 'l' ? c.x0 === 0 : edge === 'r' ? c.x1 === fw - 1 : edge === 't' ? c.y0 === 0 : c.y1 === fh - 1;
      const longEnough = edge === 'l' || edge === 'r' ? c.y1 - c.y0 + 1 >= long * h : c.x1 - c.x0 + 1 >= long * w;
      if (touches && longEnough) keep.add(c.id);
    });
    if (keep.size) for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) if (keep.has(lab[y * fw + x])) out[(y0 + y) * w + x0 + x] = 1;
  }
  return out;
}

// Graffetta automatica: il segmento dritto di pixel grigi (scuri o lucidi) più lungo, al massimo uno.
function autoStaple(prep) {
  const { cw: w, ch: h, sat, lum, ok, lumPaper } = prep, side = Math.min(w, h), m = new Uint8Array(w * h);
  for (let k = 0; k < w * h; k++) m[k] = ok[k] && sat[k] < STAPLE_GREY && (lum[k] < STAPLE_DARK * lumPaper || lum[k] > STAPLE_SHINY * lumPaper) ? 1 : 0;
  const { lab, comps } = components(closeMask(m, w, h, 1), w, h);
  let best = null, bestLen = 0;
  for (const c of comps) {
    if (c.area < 0.0005 * w * h || Math.max(c.x1 - c.x0 + 1, c.y1 - c.y0 + 1) < STAPLE_LEN[0] * side) continue;
    // asse principale (componenti principali) e distanze dall'asse
    let sx = 0, sy = 0, n = 0;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (lab[y * w + x] === c.id) { sx += x; sy += y; n++; }
    const mx = sx / n, my = sy / n;
    let cxx = 0, cyy = 0, cxy = 0;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (lab[y * w + x] === c.id) { const dx = x - mx, dy = y - my; cxx += dx * dx; cyy += dy * dy; cxy += dx * dy; }
    const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy), ca = Math.cos(ang), sa = Math.sin(ang), us = [];
    let near = 0;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
      if (lab[y * w + x] !== c.id) continue;
      const dx = x - mx, dy = y - my;
      if (Math.abs(-dx * sa + dy * ca) <= STAPLE_WIDTH * side) { near++; us.push(dx * ca + dy * sa); }
    }
    if (near < STAPLE_STRAIGHT * n) continue;
    const len = percentile(us, 0.98) - percentile(us, 0.02);
    if (len < STAPLE_LEN[0] * side || len > STAPLE_LEN[1] * side || near < STAPLE_FULL * len * 2 * STAPLE_WIDTH * side) continue;
    if (len > bestLen) { best = c; bestLen = len; }
  }
  const out = new Uint8Array(w * h);
  if (!best) return out;
  for (let k = 0; k < w * h; k++) if (lab[k] === best.id) out[k] = 1;
  return dilateDisc(out, w, h, Math.max(1, Math.round(STAPLE_BUFFER * side)));
}

// Valori per pixel che non dipendono dalla graffetta: v (con la luce locale), livelli di carta e macchie, esclusioni.
function prepareCard(crop, cw, ch, gains, leaf, bgLum) {
  const n = cw * ch, d = crop.data;
  if (gains) for (let i = 0; i < d.length; i += 4) { d[i] = d[i] * gains[0]; d[i + 1] = d[i + 1] * gains[1]; d[i + 2] = d[i + 2] * gains[2]; }
  const sat = new Float32Array(n), lum = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const r = d[4 * k], g = d[4 * k + 1], b = d[4 * k + 2], mx = Math.max(r, g, b);
    lum[k] = mx; sat[k] = (mx - Math.min(r, g, b)) / Math.max(mx, 1);
  }
  const notLeaf = new Uint8Array(n);
  for (let k = 0; k < n; k++) notLeaf[k] = leaf[k] ? 0 : 1;
  const strip = borderStrips(sat, notLeaf, cw, ch), ok = new Uint8Array(n);
  let nOk = 0;
  for (let k = 0; k < n; k++) { ok[k] = notLeaf[k] && !strip[k] ? 1 : 0; nOk += ok[k]; }
  const okSel = (k) => ok[k] === 1;
  const lumRef = bgLum || percentile(pick(lum, okSel), 0.95) || 255;
  let v = new Float32Array(n);
  for (let k = 0; k < n; k++) v[k] = ((d[4 * k] + d[4 * k + 1]) / 2 - d[4 * k + 2]) / lumRef;
  const levels = (v) => {
    const p95 = nOk ? percentile(pick(v, okSel), 0.95) : PAPER_MIN, lim = 0.75 * Math.max(p95, PAPER_MIN);
    const paperPx = new Uint8Array(n);
    let cnt = 0;
    for (let k = 0; k < n; k++) if (ok[k] && v[k] > lim) { paperPx[k] = 1; cnt++; }
    const paper = cnt > 0.05 * nOk ? percentile(pick(v, (k) => paperPx[k] === 1), 0.5) : PAPER_MIN;
    return { paperPx: paperPx, cnt: cnt, paper: Math.max(paper, PAPER_MIN) };
  };
  let L = levels(v);
  const lumPaper = L.cnt ? percentile(pick(lum, (k) => L.paperPx[k] === 1), 0.5) : lumRef;
  if (L.cnt > 0.05 * nOk) {
    // luce zona per zona, dalla carta: in ombra la carta è meno gialla in assoluto, ma non è una macchia
    const sig = LOCAL_LIGHT * Math.min(cw, ch), wp = new Float32Array(n), wl = new Float32Array(n);
    for (let k = 0; k < n; k++) { wp[k] = L.paperPx[k]; wl[k] = L.paperPx[k] * lum[k]; }
    const W = gaussBlur(wp, cw, ch, sig), Lm = gaussBlur(wl, cw, ch, sig);
    for (let k = 0; k < n; k++) {
      const loc = W[k] > 0.05 ? Lm[k] / Math.max(W[k], 1e-6) : lumPaper;
      v[k] /= Math.min(LIGHT_LIMITS[1], Math.max(LIGHT_LIMITS[0], loc / lumPaper));
    }
    L = levels(v);
  }
  // macchia piena: un valore tipico delle macchie sicure (sotto la metà tra carta e STAIN_MAX), non il più estremo
  const sure = pick(v, (k) => ok[k] === 1 && v[k] < (L.paper + STAIN_MAX) / 2);
  const stain = Math.min(sure.length > STAIN_SURE * nOk ? percentile(sure, STAIN_TYPICAL) : STAIN_MAX, STAIN_MAX);
  const glare = new Uint8Array(n), bg = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (ok[k] && sat[k] < GLARE_CHROMA && lum[k] > GLARE_LUM * lumPaper) glare[k] = 1;
    bg[k] = leaf[k] ? 1 : strip[k] ? 5 : glare[k] ? 4 : 0;   // codici della maschera (2 = graffetta)
  }
  return { sat: sat, lum: lum, ok: ok, v: v, paper: L.paper, stain: stain, lumPaper: lumPaper, bg: bg };
}

// Copertura con la graffetta indicata (clip: maschera 0/1), maschera e foto con la graffetta in arancio.
function cardResult(prep, clip) {
  const { cw, ch, v, bg, paper, stain } = prep, n = cw * ch;
  const crop = new ImageData(new Uint8ClampedArray(prep.crop.data), cw, ch);
  const mask = new ImageData(cw, ch), mk = mask.data, top = paper - DEAD_ZONE, span = Math.max(top - stain, 1e-3);
  let valid = 0, sum = 0, clipCount = 0;
  const gValid = new Float32Array(SIG_GRID * SIG_GRID), gStain = new Float32Array(SIG_GRID * SIG_GRID);
  for (let k = 0; k < n; k++) {
    let rgb, code = bg[k];
    if (clip[k] && code !== 1 && code !== 5) { code = 2; clipCount++; }
    if (code === 1) rgb = [190, 214, 178];
    else if (code === 2) {
      rgb = [224, 123, 36];
      for (let c = 0; c < 3; c++) crop.data[4 * k + c] = Math.round(0.45 * crop.data[4 * k + c] + 0.55 * rgb[c]);
    } else if (code === 4) rgb = [150, 200, 240];
    else if (code === 5) rgb = [200, 170, 220];
    else {
      const f = Math.min(1, Math.max(0, (top - v[k]) / span)), g = Math.round(255 - 220 * f);
      valid++; sum += f; rgb = [g, g, g];
      const cell = Math.min(SIG_GRID - 1, Math.floor((k / cw | 0) * SIG_GRID / ch)) * SIG_GRID + Math.min(SIG_GRID - 1, Math.floor((k % cw) * SIG_GRID / cw));
      gValid[cell]++; gStain[cell] += f;
    }
    mk[4 * k] = rgb[0]; mk[4 * k + 1] = rgb[1]; mk[4 * k + 2] = rgb[2]; mk[4 * k + 3] = 255;
  }
  const out = document.createElement('canvas');
  out.width = cw; out.height = ch;
  const octx = out.getContext('2d');
  octx.putImageData(crop, 0, 0);
  const cropUrl = out.toDataURL('image/jpeg', 0.9);
  octx.putImageData(mask, 0, 0);
  const maskUrl = out.toDataURL('image/png');
  const cellN = n / (SIG_GRID * SIG_GRID);
  const sig = Array.from(gValid, (c, g) => (c < SIG_MIN_VALID * cellN ? '-' : Math.min(35, Math.round(35 * gStain[g] / c)).toString(36))).join('');
  return { coverage: valid ? 100 * sum / valid : 0, clipFrac: 100 * clipCount / n, cropUrl: cropUrl, maskUrl: maskUrl, sig: sig, hash: prep.hash };
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

// Graffetta automatica (tap = null: quella trovata dall'analisi) o guidata dal tocco (tap = {x, y} in pixel della cartina).
function clipZones(prep, tap) {
  const { cw, ch, E } = prep, side = Math.max(cw, ch), s = CLIP_GRID / side;
  if (!tap) return prep.autoClip;
  const bar = findBar(E, cw, ch, { x: tap.x * s, y: tap.y * s });
  if (bar && bar.resp >= CLIP_TAP_RESP) return barMask(E, cw, ch, bar);
  // nessuna barra riconoscibile: si esclude un cerchio intorno al tocco
  const out = new Uint8Array(cw * ch), r = CLIP_TAP_DISC * side;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if ((x - tap.x) ** 2 + (y - tap.y) ** 2 <= r * r) out[y * cw + x] = 1;
  return out;
}

const NOT_FOUND = 'Non trovo la cartina. Prova ad avvicinarti e a metterla al centro del riquadro.';

// src: video, canvas o immagine; region: parte di src da considerare (il riquadro guida), in px di src.
function analyzeCard(src, region) {
  const scale = Math.min(1, MAX_SIDE / Math.max(region.w, region.h));
  const w = Math.round(region.w * scale), h = Math.round(region.h * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, region.x, region.y, region.w, region.h, 0, 0, w, h);
  const small = ctx.getImageData(0, 0, w, h).data;
  const leaf = leafZones(small, w, h);
  const bgInfo = borderBalance(small, leaf, w, h), gains = bgInfo && bgInfo.gains;
  if (gains) for (let i = 0; i < small.length; i += 4) { small[i] *= gains[0]; small[i + 1] *= gains[1]; small[i + 2] *= gains[2]; }

  let found = null;
  for (const d of FIND_DIFF) if ((found = findCard(small, leaf, w, h, bgInfo && bgInfo.lum, d)).corners) break;
  if (!found.corners) return { error: NOT_FOUND, reason: found.reason };

  // ritaglio raddrizzato dall'originale, a risoluzione più alta di quella su cui si è cercata la cartina
  const corners = found.corners.map(([x, y]) => [region.x + x / scale, region.y + y / scale]);
  const { crop, cw, ch, H } = warpCard(src, corners);
  const n = cw * ch, cleaf = new Uint8Array(n);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const [u, v] = applyH(H, x, y);
    const lx = Math.min(w - 1, Math.max(0, Math.round((u - region.x) * scale))), ly = Math.min(h - 1, Math.max(0, Math.round((v - region.y) * scale)));
    cleaf[y * cw + x] = leaf[ly * w + lx];
  }
  if (n - cleaf.reduce((a, v) => a + v, 0) < 0.3 * n) return { error: NOT_FOUND, reason: 'foglia' };
  let hash = 2166136261;   // FNV-1a su un pixel ogni 7: stesso file caricato due volte, stessi pixel
  for (let k = 0; k < crop.data.length; k += 28) { hash ^= crop.data[k] ^ (crop.data[k + 1] << 8) ^ (crop.data[k + 2] << 16); hash = Math.imul(hash, 16777619); }
  const p = prepareCard(crop, cw, ch, gains, cleaf, bgInfo && bgInfo.lum);
  const excl = new Uint8Array(n);
  for (let k = 0; k < n; k++) excl[k] = p.ok[k] ? 0 : 1;
  const prep = Object.assign(p, { crop: crop, cw: cw, ch: ch, E: clipEvidence(crop.data, excl, n), hash: cw + 'x' + ch + ':' + (hash >>> 0).toString(36) });
  prep.autoClip = autoStaple(prep);
  // box: dove è stata trovata la cartina, in pixel dell'immagine originale (angoli, rettangolo diritto che la
  // contiene e bilanciamento usato), per la taratura del ritaglio
  const xs = corners.map((q) => q[0]), ys = corners.map((q) => q[1]);
  const box = { x: Math.round(Math.min.apply(null, xs)), y: Math.round(Math.min.apply(null, ys)),
    w: Math.round(Math.max.apply(null, xs) - Math.min.apply(null, xs)), h: Math.round(Math.max.apply(null, ys) - Math.min.apply(null, ys)),
    angoli: corners.map((q) => [Math.round(q[0]), Math.round(q[1])]), bilanciamento: gains ? gains.map((g) => Math.round(g * 100) / 100) : null };
  return { prep: prep, result: cardResult(prep, prep.autoClip), box: box };
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
const ANALISI_PARAMETRI = { GUIDE, MAX_SIDE, BG_RING, BG_MAX_CHROMA, FIND_DIFF, FIND_CLOSE, CARD_FILL, QUAD_MIN, CARD_MIN, LEAF_GR, LEAF_WIN,
  LEAF_FRAC, EDGE_INSET, CARD_SIDE, PAPER_MIN, STAIN_MAX, STAIN_SURE, STAIN_TYPICAL, DEAD_ZONE, LOCAL_LIGHT, LIGHT_LIMITS, STRIP_NEUTRAL, STRIP_SIZE, STRIP_DENSE, GLARE_CHROMA,
  GLARE_LUM, STAPLE_GREY, STAPLE_DARK, STAPLE_SHINY, STAPLE_LEN, STAPLE_WIDTH, STAPLE_STRAIGHT, STAPLE_FULL, STAPLE_BUFFER, CLIP_GREY,
  CLIP_DARK, CLIP_VIOLET, CLIP_GRID, CLIP_LENS, CLIP_WIDTH, CLIP_ANGLES, CLIP_TAP_RESP, CLIP_TAP_RADIUS, CLIP_TAP_DISC, CLIP_EDGE,
  CLIP_BUFFER, SIG_GRID, SIG_MIN_VALID, SIG_MIN_SPREAD, DUP_SIMILAR };
