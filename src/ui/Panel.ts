/** 极简的手写调试面板：滑块、按钮、分段选择、状态行。后续的互动面板也基于它。 */

type fmt = (v: number) => string;

export class Panel {
  readonly el: HTMLElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('aside');
    this.el.className = 'panel';
    parent.appendChild(this.el);
  }

  get visible(): boolean {
    return !this.el.classList.contains('is-hidden');
  }

  set visible(v: boolean) {
    this.el.classList.toggle('is-hidden', !v);
  }

  header(title: string, subtitle: string): void {
    const h = document.createElement('div');
    h.className = 'panel__header';
    const t = document.createElement('div');
    t.className = 'panel__title';
    t.textContent = title;
    const s = document.createElement('div');
    s.className = 'panel__sub';
    s.textContent = subtitle;
    h.append(t, s);
    this.el.appendChild(h);
  }

  /** 返回该分组的容器，后续控件往里放。 */
  section(title: string): HTMLElement {
    const box = document.createElement('section');
    box.className = 'panel__section';
    const h = document.createElement('div');
    h.className = 'panel__section-title';
    h.textContent = title;
    box.appendChild(h);
    this.el.appendChild(box);
    return box;
  }

  private row(parent: HTMLElement, label: string): HTMLElement {
    const r = document.createElement('label');
    r.className = 'row';
    const name = document.createElement('span');
    name.className = 'row__label';
    name.textContent = label;
    const ctl = document.createElement('span');
    ctl.className = 'row__ctl';
    r.append(name, ctl);
    parent.appendChild(r);
    return ctl;
  }

  slider(
    parent: HTMLElement,
    label: string,
    min: number,
    max: number,
    step: number,
    value: number,
    onInput: (v: number) => void,
    format: fmt = (v) => v.toFixed(2),
  ): { set(v: number): void; get(): number } {
    const out = this.row(parent, label);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const val = document.createElement('span');
    val.className = 'row__val';
    val.textContent = format(value);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      val.textContent = format(v);
      onInput(v);
    });
    out.append(input, val);
    return {
      set(v: number) {
        input.value = String(v);
        val.textContent = format(v);
      },
      get: () => parseFloat(input.value),
    };
  }

  button(parent: HTMLElement, label: string, onClick: () => void, hint?: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn';
    b.textContent = label;
    if (hint) b.title = hint;
    b.addEventListener('click', onClick);
    parent.appendChild(b);
    return b;
  }

  /** 一排互斥按钮。 */
  segmented(parent: HTMLElement, options: readonly string[], index: number, onPick: (i: number) => void): void {
    const wrap = document.createElement('div');
    wrap.className = 'seg';
    options.forEach((label, i) => {
      const b = this.button(wrap, label, () => {
        wrap.querySelectorAll('.btn').forEach((x) => x.classList.remove('is-on'));
        b.classList.add('is-on');
        onPick(i);
      });
      if (i === index) b.classList.add('is-on');
    });
    parent.appendChild(wrap);
  }

  toggle(parent: HTMLElement, label: string, value: boolean, onChange: (v: boolean) => void): void {
    const out = this.row(parent, label);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value;
    input.addEventListener('change', () => onChange(input.checked));
    out.appendChild(input);
  }

  stat(parent: HTMLElement, label: string): { set(text: string): void } {
    const r = document.createElement('div');
    r.className = 'stat';
    const k = document.createElement('span');
    k.textContent = label;
    const v = document.createElement('span');
    v.className = 'stat__v';
    r.append(k, v);
    parent.appendChild(r);
    return {
      set(text: string) {
        v.textContent = text;
      },
    };
  }
}
