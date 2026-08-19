/**
 * Financial Digital Twin — entry point.
 *
 * Loads the tax rule packs and the saved model, mounts the UI, and re-renders whenever the
 * store changes. Deliberately thin: everything interesting is in `model/` (pure, testable
 * under `node --test`) and `ui/` (rendering only).
 */

import { createAppStore } from './ui/store.js';
import { registerBuiltInCloseRules } from './model/close-rules.js';
import { loadRulePack, packLabel } from './model/tax/rule-pack.js';
import { isAdvanced, viewsFor } from './model/complexity.js';
import { exportFilename, loadSampleTemplate } from './model/persistence.js';
import { destroyAllCharts } from './ui/charts.js';
import { el } from './ui/tables.js';
import { askForPassword } from './ui/password.js';
import {
  assumptionsView, dashboardView, scenariosView, sourcesView, taxesView,
} from './ui/views.js';

const TAX_YEARS = [2026];

const VIEWS = {
  dashboard: { label: 'Dashboard', render: (store) => dashboardView(store) },
  income: { label: 'Income', render: (store) => sourcesView(store, 'income') },
  expenses: { label: 'Expenses', render: (store) => sourcesView(store, 'expense') },
  taxes: { label: 'Taxes', render: (store) => taxesView(store) },
  scenarios: { label: 'Scenarios', render: (store) => scenariosView(store) },
  assumptions: { label: 'Assumptions', render: (store) => assumptionsView(store) },
};

let currentView = 'dashboard';

export function announce(message) {
  const region = document.getElementById('live-region');
  if (region) region.textContent = message;
}

/* -------------------------------------------------------------------------- */

async function loadTaxPacks() {
  const packs = [];
  for (const year of TAX_YEARS) {
    try {
      packs.push(await loadRulePack(year));
    } catch {
      // Without a pack the app still runs; it simply does not estimate tax, and the
      // Taxes view says so rather than quietly showing a zero.
    }
  }
  return packs;
}

/* -------------------------------------------------------------------------- */

function renderHeader(store) {
  const modeSlot = document.getElementById('mode-slot');
  if (modeSlot) modeSlot.replaceChildren(renderComplexityToggle(store));

  const packChip = document.getElementById('tax-pack-chip');
  if (packChip) {
    const pack = isAdvanced(store.model) ? store.taxPacks[0] : null;
    if (pack) {
      packChip.textContent = `Tax rules: ${packLabel(pack)}`;
      packChip.hidden = false;
    } else {
      packChip.hidden = true;
    }
  }

  const scenarioChip = document.getElementById('scenario-chip');
  if (scenarioChip) {
    scenarioChip.hidden = !isAdvanced(store.model);
    const id = store.scenarioId ?? 'base';
    const name = id === 'base'
      ? 'Base'
      : store.model.scenarios.find((s) => s.id === id)?.name ?? id;
    scenarioChip.textContent = `Scenario: ${name}`;
  }
}

function renderSampleBanner(store) {
  if (!store.usingSample) return null;

  const banner = el('div', { className: 'notice notice-warn banner', role: 'status' });
  banner.append(el('strong', { text: 'You are looking at sample data. ' }));
  banner.append(el('span', {
    text: 'Nothing here is yours yet — change anything and it becomes your model.',
  }));

  const fresh = el('button', { type: 'button', text: 'Start from scratch' });
  fresh.addEventListener('click', () => {
    if (!confirm('Clear the sample and start with an empty model?')) return;
    void store.clear();
    announce('Started a new, empty model.');
  });
  banner.append(fresh);
  return banner;
}

function renderErrorBanner(store) {
  if (!store.lastError) return null;
  const banner = el('div', { className: 'notice notice-error', role: 'alert' });
  banner.append(el('strong', { text: 'Your changes were not saved. ' }));
  banner.append(el('span', { text: store.lastError.message }));
  return banner;
}

/**
 * The simple/advanced switch.
 *
 * Lives in the header rather than buried in settings, because a user who has hit the edge
 * of simple mode needs to find it immediately. The label says what it does, not what it is.
 */
function renderComplexityToggle(store) {
  const advanced = isAdvanced(store.model);
  const wrap = el('div', { className: 'mode-toggle' });

  const button = el('button', {
    type: 'button',
    className: `mode-button${advanced ? ' mode-on' : ''}`,
    'aria-pressed': advanced ? 'true' : 'false',
    text: advanced ? 'Advanced' : 'Simple',
    title: advanced
      ? 'Showing everything: taxes, scenarios, investments and debts.'
      : 'Showing the essentials. Click for taxes, scenarios, investments and debts.',
  });

  button.addEventListener('click', () => {
    const next = advanced ? 'simple' : 'advanced';
    store.setComplexity(next);
    announce(next === 'advanced'
      ? 'Advanced features on. Taxes, scenarios and assumptions are now available.'
      : 'Simple mode. Your plan is unchanged — some sections are just hidden.');
  });

  wrap.append(el('span', { className: 'mode-label', text: 'Mode' }), button);
  return wrap;
}

/** Hand the browser a file. Same path for both kinds of export. */
function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Import a file of either kind, asking for a password only once we know one is needed.
 *
 * The retry loop matters: a mistyped password is the expected case, and making the user
 * re-pick the file each time would be a small cruelty.
 */
async function importFile(store, text) {
  if (!store.isEncryptedExport(text)) {
    store.importJson(text);
    announce('Model imported.');
    return;
  }

  for (;;) {
    const password = await askForPassword({
      title: 'This file is encrypted',
      message: 'Enter the password it was exported with.',
      submitLabel: 'Decrypt and import',
    });
    if (!password) {
      announce('Import cancelled.');
      return;
    }

    announce('Decrypting. This takes a moment.');
    try {
      await store.importAny(text, password);
      announce('Encrypted model imported.');
      return;
    } catch (err) {
      // A wrong password is worth another try; a corrupt or unsupported file is not.
      if (err.code !== 'crypto.wrong_password') throw err;
      alert(err.message);
    }
  }
}

function renderToolbar(store) {
  const bar = el('div', { className: 'toolbar' });

  // Scenarios are an advanced idea; the picker only appears once they exist.
  if (isAdvanced(store.model)) {
    const scenarioLabel = el('label', { for: 'scenario-select', text: 'Viewing' });
    const select = el('select', { id: 'scenario-select' });
    select.append(el('option', { value: 'base', text: 'Base plan' }));
    for (const scenario of store.model.scenarios) {
      const option = el('option', { value: scenario.id, text: scenario.name });
      if (store.scenarioId === scenario.id) option.selected = true;
      select.append(option);
    }
    select.addEventListener('change', () => store.setScenario(select.value));
    bar.append(scenarioLabel, select);
  }

  const exportBtn = el('button', { type: 'button', text: 'Export JSON' });
  exportBtn.addEventListener('click', () => {
    downloadText(store.exportJson(), exportFilename());
    announce('Model exported. It contains personal financial information — store it securely.');
  });

  const encryptBtn = el('button', {
    type: 'button',
    text: 'Export encrypted…',
    title: 'Export a file that only opens with a password you choose.',
  });
  encryptBtn.addEventListener('click', async () => {
    const password = await askForPassword({
      title: 'Encrypt this export',
      message:
        'The file will only open with this password. It is not stored anywhere and it ' +
        'cannot be reset or recovered — if you lose it, the file is gone.',
      confirm: true,
      submitLabel: 'Encrypt and download',
    });
    if (!password) return;

    // Key derivation is deliberately slow — around a second on a phone. Say so, rather
    // than letting the button look dead.
    encryptBtn.disabled = true;
    const label = encryptBtn.textContent;
    encryptBtn.textContent = 'Encrypting…';
    announce('Encrypting your model. This takes a moment.');
    try {
      const text = await store.exportEncrypted(password);
      downloadText(text, exportFilename(undefined, { encrypted: true }));
      announce('Encrypted model exported. Keep the password safe — it cannot be recovered.');
    } catch (err) {
      alert(`That export could not be encrypted: ${err.message}`);
    } finally {
      encryptBtn.disabled = false;
      encryptBtn.textContent = label;
    }
  });

  const importBtn = el('button', { type: 'button', text: 'Import JSON' });
  const picker = el('input', { type: 'file', accept: 'application/json,.json', hidden: 'hidden' });
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    if (!file) return;
    try {
      await importFile(store, await file.text());
    } catch (err) {
      alert(`That file could not be imported: ${err.message}`);
    }
    picker.value = '';
  });
  importBtn.addEventListener('click', () => picker.click());

  const resetBtn = el('button', { type: 'button', className: 'danger', text: 'Delete local data' });
  resetBtn.addEventListener('click', () => {
    if (!confirm('Delete everything stored in this browser? Export first if you want a copy — this cannot be undone.')) return;
    void store.clear();
    announce('Local data deleted.');
  });

  bar.append(exportBtn, encryptBtn, importBtn, picker, resetBtn);
  return bar;
}

function render(store) {
  const root = document.getElementById('view-root');
  if (!root) return;

  // Chart.js holds canvases and listeners; drop them before replacing the DOM.
  destroyAllCharts();
  root.replaceChildren();

  renderHeader(store);

  for (const node of [renderErrorBanner(store), renderSampleBanner(store), renderToolbar(store)]) {
    if (node) root.append(node);
  }

  // Hide sections the current level does not offer, and fall back to the dashboard if the
  // section being viewed has just gone away.
  const available = new Set(viewsFor(store.model));
  if (!available.has(currentView)) currentView = 'dashboard';

  for (const button of document.querySelectorAll('.nav-btn')) {
    const view = button.dataset.view;
    const allowed = available.has(view);
    button.hidden = !allowed;
    // On a phone the nav is a tab bar whose items share the width evenly, so an item left
    // holding a hidden button would show as a blank tab.
    if (button.parentElement) button.parentElement.hidden = !allowed;
    if (allowed && view === currentView) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }

  try {
    root.append(VIEWS[currentView].render(store));
  } catch (err) {
    const failure = el('div', { className: 'notice notice-error', role: 'alert' });
    failure.append(el('strong', { text: 'Something went wrong drawing this view. ' }));
    failure.append(el('span', { text: err.message }));
    failure.append(el('p', {
      className: 'muted',
      text: 'Your data is unchanged. Export it before making further edits.',
    }));
    root.append(failure);
    console.error(err);
  }
}

function wireNav(store) {
  for (const button of document.querySelectorAll('.nav-btn')) {
    button.addEventListener('click', () => {
      currentView = button.dataset.view;
      render(store);
      document.getElementById('main')?.focus();
      announce(`${VIEWS[currentView].label} view`);
    });
  }
}

/* -------------------------------------------------------------------------- */

async function boot() {
  const status = document.getElementById('boot-status');
  // Tells the watchdog in boot-check.js that module loading worked.
  globalThis.__fdtBooted = true;

  try {
    registerBuiltInCloseRules();

    const store = createAppStore({ packs: await loadTaxPacks() });

    // The scenario currently being viewed lives on the store so every view agrees.
    store.scenarioId = 'base';
    store.setScenario = (id) => {
      store.scenarioId = id;
      render(store);
      announce(id === 'base' ? 'Viewing the base plan.' : 'Viewing a scenario.');
    };

    const saved = await store.load();
    if (saved) {
      store.setModel(saved, { persist: false });
    } else {
      try {
        const sample = await loadSampleTemplate();
        if (sample) {
          store.setModel(sample.model, { sample: true, persist: false });
          announce(`Loaded sample data: ${sample.name}.`);
        }
      } catch {
        // No sample available — an empty model is a perfectly good starting point.
      }
    }

    store.subscribe(() => render(store));
    wireNav(store);
    status?.remove();
    render(store);
  } catch (err) {
    if (status) {
      status.className = 'notice notice-error';
      status.textContent = `Could not start: ${err.message}`;
    }
    throw err;
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
