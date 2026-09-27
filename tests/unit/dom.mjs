// The smallest DOM Preact needs to render elements and text in Node, so hooks
// such as useStore can be tested without a browser. Install it before any
// test renders; nothing here is used by the application.
class Node {
  constructor(nodeType, name) {
    this.nodeType = nodeType;
    this.nodeName = name;
    this.localName = name.toLowerCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get nextSibling() {
    const siblings = this.parentNode?.childNodes || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get textContent() {
    return this.nodeType === 3
      ? this.data
      : this.childNodes.map((node) => node.textContent).join('');
  }
  insertBefore(node, before) {
    node.parentNode?.removeChild(node);
    const index = before ? this.childNodes.indexOf(before) : -1;
    if (index < 0) this.childNodes.push(node);
    else this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  appendChild(node) {
    return this.insertBefore(node, null);
  }
  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  addEventListener() {}
  removeEventListener() {}
}

export function installDOM() {
  globalThis.document = {
    createElement: (name) => new Node(1, name.toUpperCase()),
    createElementNS: (_namespace, name) => new Node(1, name.toUpperCase()),
    createTextNode: (data) => Object.assign(new Node(3, '#text'), { data: String(data) }),
  };
  return () => new Node(1, 'DIV');
}

// Preact renders on a microtask after a state change; this waits for it.
export function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
