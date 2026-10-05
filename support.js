/*
 * support.js: runtime minimale per aprire i file .dc.html (Design canvas) in un browser normale.
 *
 * Gestisce: <helmet>, <x-dc>, {{percorso.valore}}, <sc-if value>, <sc-for list as>,
 * eventi onClick/onChange/onFocus, e la classe `Component extends DCLogic`
 * (state, setState, renderVals, componentDidMount, componentWillUnmount).
 *
 * Trucco: il resto del documento viene letto come testo grezzo (<plaintext>) e
 * parsato qui, così i <sc-for> dentro <tbody> non vengono spostati dal parser HTML.
 */
(function () {
  'use strict';

  // Blocca il parsing normale del resto della pagina: diventa testo grezzo.
  document.write('<plaintext id="__dc_src" style="display:none">');

  // ---------- DCLogic ----------
  class DCLogic {
    constructor(props) {
      this.props = props || {};
      this.state = {};
      this.__pending = null;
      this.__callbacks = [];
      this.__render = null;
    }
    setState(update, cb) {
      const base = Object.assign({}, this.state, this.__pending || {});
      const patch = typeof update === 'function' ? update(base, this.props) : update;
      if (patch) this.__pending = Object.assign(this.__pending || {}, patch);
      if (cb) this.__callbacks.push(cb);
      if (!this.__scheduled) {
        this.__scheduled = true;
        queueMicrotask(() => {
          this.__scheduled = false;
          if (this.__pending) {
            this.state = Object.assign({}, this.state, this.__pending);
            this.__pending = null;
          }
          if (this.__render) this.__render();
          const cbs = this.__callbacks.splice(0);
          cbs.forEach((f) => f.call(this));
        });
      }
    }
    forceUpdate() { this.setState({}); }
    renderVals() { return {}; }
  }
  window.DCLogic = DCLogic;

  // ---------- Interpolazione ----------
  const WHOLE = /^\{\{\s*([^}]+?)\s*\}\}$/;
  const ANY = /\{\{\s*([^}]+?)\s*\}\}/g;

  function lookup(expr, scope) {
    if (expr === 'true') return true;
    if (expr === 'false') return false;
    if (expr === 'null') return null;
    if (expr === 'undefined') return undefined;
    if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
    if (/^(['"]).*\1$/.test(expr)) return expr.slice(1, -1);
    const parts = expr.split('.');
    let v = scope[parts[0]];
    for (let i = 1; i < parts.length; i++) {
      if (v == null) return undefined;
      v = v[parts[i]];
    }
    return v;
  }

  function toText(v) {
    return v == null || v === false ? '' : String(v);
  }

  // Valore "grezzo" se l'attributo è un solo {{x}}, altrimenti stringa interpolata.
  function interp(str, scope) {
    const m = WHOLE.exec(str);
    if (m) return lookup(m[1], scope);
    if (str.indexOf('{{') === -1) return str;
    return str.replace(ANY, (_, e) => toText(lookup(e, scope)));
  }

  // ---------- Template -> nodi virtuali ----------
  function childrenOf(tpl) {
    // <template> HTML ha .content; dentro SVG è un elemento normale.
    return tpl.content ? tpl.content.childNodes : tpl.childNodes;
  }

  function build(nodes, scope, out) {
    for (const n of nodes) {
      if (n.nodeType === 3) {
        out.push({ text: n.nodeValue.indexOf('{{') === -1 ? n.nodeValue : n.nodeValue.replace(ANY, (_, e) => toText(lookup(e, scope))) });
      } else if (n.nodeType === 1) {
        const kind = n.localName === 'template' && n.getAttribute('data-sc');
        if (kind === 'if') {
          if (interp(n.getAttribute('value') || '', scope)) build(childrenOf(n), scope, out);
        } else if (kind === 'for') {
          const list = interp(n.getAttribute('list') || '', scope);
          const as = n.getAttribute('as') || 'item';
          if (list && typeof list.length === 'number') {
            Array.prototype.forEach.call(list, (item, i) => {
              const s = Object.create(scope);
              s[as] = item;
              s[as + 'Index'] = i;
              build(childrenOf(n), s, out);
            });
          }
        } else {
          const attrs = [];
          for (const a of n.attributes) {
            if (a.name.startsWith('hint-')) continue;
            attrs.push([a.name, interp(a.value, scope)]);
          }
          const kids = [];
          build(n.localName === 'template' ? n.content.childNodes : n.childNodes, scope, kids);
          out.push({ tag: n.localName, ns: n.namespaceURI, attrs, kids });
        }
      }
    }
    return out;
  }

  // ---------- Patch del DOM reale ----------
  const BOOL_PROPS = { checked: 1, disabled: 1, selected: 1, readonly: 'readOnly', multiple: 1, hidden: 1 };

  function eventName(el, attr) {
    const ev = attr.slice(2);
    if (ev === 'change') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (el.localName === 'textarea') return 'input';
      if (el.localName === 'input' && !['checkbox', 'radio', 'file'].includes(t)) return 'input';
    }
    if (ev === 'doubleclick') return 'dblclick';
    return ev;
  }

  function truthy(v) {
    return !(v === false || v == null || v === 'false' || v === '');
  }

  function patchEl(el, v) {
    const prev = el.__dcAttrs || {};
    const now = {};
    let valueProp;
    el.__dcH = el.__dcH || {};
    const handlers = {};

    for (const [name, val] of v.attrs) {
      if (name.startsWith('on') && name.length > 2) {
        const ev = eventName(el, name);
        handlers[ev] = typeof val === 'function' ? val : null;
        continue;
      }
      if (name === 'value' && (el.localName === 'input' || el.localName === 'textarea' || el.localName === 'select')) {
        valueProp = val;
        if (el.localName !== 'select') el.setAttribute('value', toText(val));
        now[name] = 1;
        continue;
      }
      if (BOOL_PROPS[name] && el.namespaceURI === 'http://www.w3.org/1999/xhtml') {
        const prop = BOOL_PROPS[name] === 1 ? name : BOOL_PROPS[name];
        const on = truthy(val);
        el[prop] = on;
        if (on) el.setAttribute(name, ''); else el.removeAttribute(name);
        now[name] = 1;
        continue;
      }
      if (val == null || val === false) {
        if (!name.startsWith('aria-')) { el.removeAttribute(name); continue; }
      }
      const s = val === true ? (name.startsWith('aria-') ? 'true' : '') : String(val);
      if (el.getAttribute(name) !== s) el.setAttribute(name, s);
      now[name] = 1;
    }
    for (const name in prev) if (!now[name]) el.removeAttribute(name);
    el.__dcAttrs = now;

    // Eventi: un listener fisso per tipo che richiama l'handler corrente.
    for (const ev in el.__dcH) if (!(ev in handlers)) el.__dcH[ev] = null;
    for (const ev in handlers) {
      if (!(ev in el.__dcH)) {
        el.addEventListener(ev, (e) => { const h = el.__dcH[ev]; if (h) h(e); });
      }
      el.__dcH[ev] = handlers[ev];
    }

    patchChildren(el, v.kids);

    if (valueProp !== undefined) {
      const s = toText(valueProp);
      if (el.value !== s) el.value = s;
    }
  }

  function create(v) {
    if ('text' in v) return document.createTextNode(v.text);
    return v.ns && v.ns !== 'http://www.w3.org/1999/xhtml'
      ? document.createElementNS(v.ns, v.tag)
      : document.createElement(v.tag);
  }

  function same(node, v) {
    if ('text' in v) return node.nodeType === 3;
    return node.nodeType === 1 && node.localName === v.tag && node.namespaceURI === (v.ns || 'http://www.w3.org/1999/xhtml');
  }

  function patchChildren(parent, vkids) {
    // <textarea>: il contenuto è il valore, non figli da patchare.
    let i = 0;
    for (; i < vkids.length; i++) {
      const v = vkids[i];
      let node = parent.childNodes[i];
      if (!node || !same(node, v)) {
        const fresh = create(v);
        if (node) parent.replaceChild(fresh, node); else parent.appendChild(fresh);
        node = fresh;
      }
      if ('text' in v) {
        if (node.nodeValue !== v.text) node.nodeValue = v.text;
      } else {
        patchEl(node, v);
      }
    }
    while (parent.childNodes.length > i) parent.removeChild(parent.lastChild);
  }

  // ---------- Avvio ----------
  function showError(err) {
    console.error(err);
    const box = document.createElement('pre');
    box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;margin:0;padding:12px 14px;background:#2b0f0f;color:#ffd7d7;font:12px/1.4 monospace;border-radius:8px;white-space:pre-wrap;max-height:40vh;overflow:auto';
    box.textContent = 'support.js: ' + (err && err.stack || err);
    document.body.appendChild(box);
  }

  function boot() {
    const holder = document.getElementById('__dc_src');
    if (!holder) return;
    let src = holder.textContent;
    holder.remove();

    // <sc-if>/<sc-for> -> <template data-sc>, che si può annidare ovunque (anche in <tbody>).
    src = src
      .replace(/<sc-(if|for)\b/g, '<template data-sc="$1"')
      .replace(/<\/sc-(if|for)\s*>/g, '</template>');

    const doc = new DOMParser().parseFromString('<!doctype html><html><head></head><body>' + src, 'text/html');

    const helmet = doc.querySelector('helmet');
    if (helmet) {
      for (const n of Array.from(helmet.childNodes)) {
        if (n.nodeType === 1) document.head.appendChild(document.importNode(n, true));
      }
      helmet.remove();
    }

    const root = doc.querySelector('x-dc');
    const script = doc.querySelector('script[data-dc-script]');
    const mount = document.createElement('div');
    mount.id = 'dc-root';
    mount.style.display = 'contents';
    document.body.appendChild(mount);

    if (!root) { showError('nessun <x-dc> trovato'); return; }

    let props = {};
    let Component = DCLogic;
    try {
      if (script) {
        props = JSON.parse(script.getAttribute('data-props') || '{}');
        Component = new Function('DCLogic', script.textContent + '\n;return typeof Component !== "undefined" ? Component : DCLogic;')(DCLogic);
      }
    } catch (e) { showError(e); return; }

    const tpl = Array.from(root.childNodes);
    let comp;
    try { comp = new Component(props); } catch (e) { showError(e); return; }

    const render = () => {
      try {
        const vals = comp.renderVals() || {};
        patchChildren(mount, build(tpl, vals, []));
      } catch (e) { showError(e); }
    };
    comp.__render = render;
    render();

    if (typeof comp.componentDidMount === 'function') {
      try { comp.componentDidMount(); } catch (e) { showError(e); }
    }
    window.addEventListener('pagehide', () => {
      if (typeof comp.componentWillUnmount === 'function') comp.componentWillUnmount();
    });
    window.__dc = comp; // comodo per il debug da console
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
