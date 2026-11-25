// Play queue with repeat (off / all / one) and shuffle. Pure logic, no DOM — unit-tested in Node.
// An item is { id, name, path? (desktop file), lib? (server library path), url? , file? (File, session only) }

let seq = 0;
export const newId = () => Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);

export class Queue {
  constructor(rand = Math.random) {
    this.items = [];
    this.index = -1;          // currently playing item
    this.repeat = 'off';      // 'off' | 'all' | 'one'
    this.shuffle = false;
    this.order = [];          // play order (indices into items)
    this.name = '';           // name of the loaded playlist, if any
    this.rand = rand;
    this.onchange = null;
  }

  get current() { return this.items[this.index] || null; }
  _changed() { if (this.onchange) this.onchange(); }

  _rebuildOrder() {
    const n = this.items.length;
    const idx = [...Array(n).keys()];
    if (!this.shuffle) { this.order = idx; return; }
    // Fisher–Yates, keeping the current item first so shuffling never interrupts playback.
    const rest = idx.filter((i) => i !== this.index);
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    this.order = this.index >= 0 ? [this.index, ...rest] : rest;
  }

  /** Append items; returns the index of the first one added. */
  add(items, { after = false } = {}) {
    const list = (Array.isArray(items) ? items : [items]).map((it) => ({ ...it, id: it.id || newId() }));
    if (!list.length) return -1;
    let at = this.items.length;
    if (after && this.index >= 0) at = this.index + 1;
    this.items.splice(at, 0, ...list);
    if (this.index >= at) this.index += list.length;
    if (this.shuffle) {
      // Shift existing order indices, then put the new items right after the current one (play next) or at random later spots.
      this.order = this.order.map((i) => (i >= at ? i + list.length : i));
      const newIdx = list.map((_, k) => at + k);
      if (after) {
        const pos = Math.max(0, this.order.indexOf(this.index)) + 1;
        this.order.splice(pos, 0, ...newIdx);
      } else {
        for (const ni of newIdx) {
          const start = Math.max(0, this.order.indexOf(this.index)) + 1;
          const pos = start + Math.floor(this.rand() * (this.order.length - start + 1));
          this.order.splice(pos, 0, ni);
        }
      }
    } else this._rebuildOrder();
    this._changed();
    return at;
  }

  remove(i) {
    if (i < 0 || i >= this.items.length) return;
    this.items.splice(i, 1);
    this.order = this.order.filter((x) => x !== i).map((x) => (x > i ? x - 1 : x));
    if (this.index === i) this.index = -1;
    else if (this.index > i) this.index--;
    this._changed();
  }

  move(from, to) {
    if (from === to || from < 0 || to < 0 || from >= this.items.length || to >= this.items.length) return;
    const [it] = this.items.splice(from, 1);
    this.items.splice(to, 0, it);
    const map = (x) => {
      if (x === from) return to;
      if (from < to && x > from && x <= to) return x - 1;
      if (from > to && x >= to && x < from) return x + 1;
      return x;
    };
    this.index = this.index >= 0 ? map(this.index) : -1;
    this.order = this.shuffle ? this.order.map(map) : [...this.items.keys()];
    this._changed();
  }

  clear() { this.items = []; this.index = -1; this.order = []; this.name = ''; this._changed(); }

  replace(items, name = '') {
    this.items = items.map((it) => ({ ...it, id: newId() }));
    this.index = -1;
    this.name = name;
    this._rebuildOrder();
    this._changed();
  }

  select(i) {
    if (i < 0 || i >= this.items.length) return null;
    this.index = i;   // shuffle order is kept; playback continues from i's place in it
    this._changed();
    return this.items[i];
  }

  setShuffle(on) { this.shuffle = !!on; this._rebuildOrder(); this._changed(); }
  setRepeat(mode) { this.repeat = ['off', 'all', 'one'].includes(mode) ? mode : 'off'; this._changed(); }
  cycleRepeat() { this.setRepeat({ off: 'all', all: 'one', one: 'off' }[this.repeat]); return this.repeat; }

  /** Index to play after the current one. auto=true when called because a video ended. */
  nextIndex(auto = false) {
    const n = this.items.length;
    if (!n) return -1;
    if (auto && this.repeat === 'one' && this.index >= 0) return this.index;
    if (this.index < 0) return this.order[0] ?? 0;
    const pos = this.order.indexOf(this.index);
    if (pos >= 0 && pos + 1 < this.order.length) return this.order[pos + 1];
    if (this.repeat === 'all' || (!auto && this.repeat === 'one')) {
      if (this.shuffle) {   // new shuffle for the next round, avoiding an immediate repeat
        const last = this.index;
        this._rebuildOrder();
        const rest = this.order.filter((x) => x !== last);
        this.order = n > 1 ? [...rest, last] : this.order;
        return this.order[0];
      }
      return this.order[0];
    }
    return -1;
  }

  prevIndex() {
    if (!this.items.length) return -1;
    if (this.index < 0) return this.order[0] ?? 0;
    const pos = this.order.indexOf(this.index);
    if (pos > 0) return this.order[pos - 1];
    if (this.repeat !== 'off') return this.order[this.order.length - 1];
    return this.index;
  }

  /** Items without session-only data (File objects), for saving. */
  serializable() {
    return this.items.filter((it) => !it.file).map(({ name, path, lib, url }) => {
      const o = { name };
      if (path) o.path = path;
      if (lib) o.lib = lib;
      if (url && !String(url).startsWith('blob:')) o.url = url;
      return o;
    });
  }

  toJSON() {
    return { items: this.serializable(), index: this.current && !this.current.file ? this.serializable().findIndex((x) => x.name === this.current.name && (x.path || x.lib || x.url) === (this.current.path || this.current.lib || this.current.url)) : -1, repeat: this.repeat, shuffle: this.shuffle, name: this.name };
  }

  restore(state) {
    if (!state || !Array.isArray(state.items)) return;
    this.items = state.items.map((it) => ({ ...it, id: newId() }));
    this.index = Number.isInteger(state.index) && state.index < this.items.length ? state.index : -1;
    this.repeat = ['off', 'all', 'one'].includes(state.repeat) ? state.repeat : 'off';
    this.shuffle = !!state.shuffle;
    this.name = state.name || '';
    this._rebuildOrder();
  }
}
