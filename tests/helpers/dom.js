/**
 * A DOM small enough to render into, and no smaller.
 *
 * Not a browser and not trying to be — but enough to prove that every view builds without
 * throwing, that the structure it produces is the one we intended, and that the accessible
 * markup (labels, roles, table headers) is actually emitted. Those are the failures worth
 * catching in CI; pixel layout is not.
 *
 * Chart.js is deliberately absent, so `charts.js` takes its degraded path — which also
 * proves the tables still carry every number when the chart cannot draw.
 */

class ClassList {
  constructor(node) { this.node = node; }
  add(...names) { for (const n of names) this.node._classes.add(n); }
  remove(...names) { for (const n of names) this.node._classes.delete(n); }
  contains(name) { return this.node._classes.has(name); }
  toString() { return [...this.node._classes].join(' '); }
}

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this._classes = new Set();
    this.attributes = new Map();
    this.listeners = new Map();
    this._text = '';
    this.classList = new ClassList(this);
    this.style = {};
    this.checked = false;
    this.selected = false;
    this.value = '';
    this.files = null;
  }

  get className() { return this.classList.toString(); }
  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      const child = typeof node === 'string' ? Object.assign(new FakeNode('#text'), { _text: node }) : node;
      child.parent = this;
      this.children.push(child);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler({ preventDefault() {}, ...event });
  }
  click() { this.dispatch('click'); }
  focus() {}
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() { return !this.validationMessage; }

  get dataset() {
    const node = this;
    return new Proxy({}, {
      get: (_, key) => node.attributes.get(`data-${String(key)}`),
      set: (_, key, value) => { node.attributes.set(`data-${String(key)}`, String(value)); return true; },
    });
  }

  /** Depth-first walk of every descendant. */
  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }

  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return this.getAttribute('id') === selector.slice(1);
    return this.tagName === selector.toUpperCase();
  }

  querySelectorAll(selector) {
    return [...this.walk()].filter((n) => n.matches(selector));
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  /** Every tag name in this subtree — handy for asserting structure. */
  tags() { return [...this.walk()].map((n) => n.tagName); }

  /** All text, flattened, for content assertions. */
  text() { return this.textContent; }
}

/** Install a fake `document` (and friends) globally. Returns a restore function. */
export function installFakeDom() {
  const registry = new Map();

  const document = {
    createElement: (tag) => new FakeNode(tag),
    getElementById: (id) => registry.get(id) ?? null,
    querySelectorAll: (selector) => {
      const out = [];
      for (const node of registry.values()) {
        if (node.matches(selector)) out.push(node);
        out.push(...node.querySelectorAll(selector));
      }
      return out;
    },
    body: new FakeNode('body'),
    readyState: 'complete',
    addEventListener() {},
    _register(id, node) {
      node.setAttribute('id', id);
      registry.set(id, node);
      return node;
    },
  };

  const previous = {
    document: globalThis.document,
    matchMedia: globalThis.matchMedia,
    getComputedStyle: globalThis.getComputedStyle,
    confirm: globalThis.confirm,
    alert: globalThis.alert,
  };

  globalThis.document = document;
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.confirm = () => true;
  globalThis.alert = () => {};

  return {
    document,
    node: (tag) => new FakeNode(tag),
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

export { FakeNode };
