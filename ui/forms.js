/**
 * Forms rendered from the registry's FieldSpecs.
 *
 * There is no per-source-type form code. A new source type declares its fields and gets an
 * editor for free — which is also why the scenario override editor works on any field of
 * any type without knowing what a rental or a royalty is.
 *
 * Essential fields show first; anything marked `advanced` hides behind a disclosure, so a
 * first-time user is not met with twenty inputs.
 */

import { getSourceType, getPath, setPath } from '../model/sources/registry.js';
import { parseMoney } from '../model/money.js';
import { el } from './tables.js';

let fieldSeq = 0;
const nextId = () => `f${++fieldSeq}`;

/** Turn a stored value into what the input should show. */
function toInputValue(value, kind) {
  if (value === null || value === undefined) return '';
  switch (kind) {
    case 'money': return (value / 100).toFixed(2);
    case 'percent': return String(Math.round(value * 1000) / 10);
    case 'bool': return value ? 'true' : 'false';
    default: return String(value);
  }
}

/** Turn what the user typed back into what the model stores. Throws on nonsense. */
export function fromInputValue(raw, kind) {
  const text = String(raw ?? '').trim();

  switch (kind) {
    case 'money':
      return text === '' ? 0 : parseMoney(text);
    case 'percent': {
      if (text === '') return 0;
      const n = Number(text);
      if (!Number.isFinite(n)) throw new Error(`"${raw}" is not a percentage`);
      return n / 100;
    }
    case 'int': {
      if (text === '') return null;
      const n = Number(text);
      if (!Number.isInteger(n)) throw new Error(`"${raw}" is not a whole number`);
      return n;
    }
    case 'bool':
      return raw === true || raw === 'true';
    case 'date':
      return text === '' ? null : text;
    default:
      return text;
  }
}

function inputFor(field, value, onChange) {
  const id = nextId();
  let input;

  if (field.kind === 'select') {
    input = el('select', { id, name: field.path });
    for (const option of field.options ?? []) {
      const node = el('option', { value: option.value, text: option.label });
      if (String(value) === String(option.value)) node.selected = true;
      input.append(node);
    }
  } else if (field.kind === 'bool') {
    input = el('input', { id, name: field.path, type: 'checkbox' });
    input.checked = Boolean(value);
  } else {
    const type = field.kind === 'date' ? 'date'
      : field.kind === 'money' || field.kind === 'percent' || field.kind === 'int' ? 'number'
      : 'text';
    input = el('input', { id, name: field.path, type });
    input.value = toInputValue(value, field.kind);
    if (field.kind === 'money') input.step = '0.01';
    if (field.kind === 'percent') input.step = '0.1';
    if (field.kind === 'int') input.step = '1';
    if (field.min !== undefined && field.kind !== 'percent') input.min = String(field.min);
    if (field.max !== undefined && field.kind !== 'percent') input.max = String(field.max);
  }

  input.addEventListener('change', () => {
    const raw = field.kind === 'bool' ? input.checked : input.value;
    try {
      onChange(fromInputValue(raw, field.kind));
      input.setCustomValidity('');
    } catch (err) {
      input.setCustomValidity(err.message);
      input.reportValidity();
    }
  });

  return { id, input };
}

function fieldRow(field, value, onChange) {
  const { id, input } = inputFor(field, value, onChange);
  const row = el('div', { className: `field field-${field.kind}` });

  const label = el('label', { for: id, text: labelWithUnit(field) });
  row.append(label, input);

  if (field.help) {
    const help = el('p', { className: 'field-help', id: `${id}-help`, text: field.help });
    input.setAttribute('aria-describedby', `${id}-help`);
    row.append(help);
  }
  return row;
}

const labelWithUnit = (field) =>
  field.kind === 'percent' ? `${field.label} (%)` : field.label;

/**
 * An editor for one source.
 *
 * @param {Object} source
 * @param {(mutate: (draft) => void) => void} apply  applies a change to the real model
 */
export function renderSourceForm(source, apply) {
  const def = getSourceType(source.type);
  const form = el('form', { className: 'source-form', autocomplete: 'off' });
  form.addEventListener('submit', (event) => event.preventDefault());

  form.append(el('h3', { text: `${def.label}` }));

  const basic = el('div', { className: 'field-grid' });
  const advanced = el('div', { className: 'field-grid' });

  for (const field of def.fields) {
    const row = fieldRow(field, getPath(source, field.path), (value) => {
      apply((draft) => {
        const target = draft.sources.find((s) => s.id === source.id);
        if (target) setPath(target, field.path, value);
      });
    });
    (field.advanced ? advanced : basic).append(row);
  }

  form.append(basic);

  if (advanced.children.length > 0) {
    const details = el('details', { className: 'advanced' });
    details.append(el('summary', { text: 'Advanced options' }));
    details.append(advanced);
    form.append(details);
  }

  const enabled = el('input', { type: 'checkbox', id: `enabled-${source.id}` });
  enabled.checked = source.enabled;
  enabled.addEventListener('change', () => {
    apply((draft) => {
      const target = draft.sources.find((s) => s.id === source.id);
      if (target) target.enabled = enabled.checked;
    });
  });
  const enabledRow = el('div', { className: 'field field-bool' });
  enabledRow.append(el('label', { for: `enabled-${source.id}`, text: 'Include in the projection' }), enabled);
  form.append(enabledRow);

  return form;
}

/** The "+ Add" picker, grouped by family. */
export function renderTypePicker(families, onPick) {
  const wrapper = el('div', { className: 'type-picker' });

  for (const [family, types] of families) {
    wrapper.append(el('h4', { text: familyLabel(family) }));
    const row = el('div', { className: 'type-row' });
    for (const def of types) {
      const button = el('button', { type: 'button', className: 'type-button', text: def.label });
      button.addEventListener('click', () => onPick(def.type));
      row.append(button);
    }
    wrapper.append(row);
  }
  return wrapper;
}

const familyLabel = (family) => ({
  income: 'Income',
  expense: 'Spending',
  transfer: 'Transfers',
  asset: 'Assets',
  liability: 'Debts',
}[family] ?? family);

/** A fresh source of a type, with an id and sensible dates already filled in. */
export function newSourceOfType(type, { startDate, personId = null }) {
  const source = getSourceType(type).defaults();
  return {
    ...source,
    id: `${type}_${Math.random().toString(36).slice(2, 8)}`,
    startDate: source.startDate || startDate,
    personId: personId ?? source.personId,
  };
}
