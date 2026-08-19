/**
 * The password prompt.
 *
 * A modal `<dialog>` rather than `window.prompt`, for three reasons that all matter here:
 * `prompt` shows the password in clear text on screen, browsers hand its value to password
 * managers as ordinary text, and it cannot ask for a confirmation field — which is the only
 * thing standing between a typo and an export that nobody can ever open again.
 *
 * The password is never stored, never logged, and never put on the model. It exists in a
 * local variable for as long as the export takes, and the input is cleared on the way out.
 */

import { el } from './tables.js';

/**
 * Ask for a password. Resolves with the string, or `null` if the user cancelled.
 *
 * @param {object} options
 * @param {string} options.title      heading, e.g. "Encrypt this export"
 * @param {string} options.message    one line explaining the consequence
 * @param {boolean} options.confirm   ask twice and require a match (use when encrypting)
 * @param {string} options.submitLabel
 * @param {number} options.minLength  refuse anything shorter (only when confirming)
 */
export function askForPassword({
  title,
  message = '',
  confirm = false,
  submitLabel = 'Continue',
  minLength = 8,
} = {}) {
  // No `<dialog>` (an old browser, or a test harness): fall back rather than fail. The
  // fallback cannot confirm a second time, so it warns instead.
  if (typeof document.createElement('dialog').showModal !== 'function') {
    const typed = globalThis.prompt?.(confirm ? `${title}\n\n${message}` : title);
    return Promise.resolve(typed ? typed : null);
  }

  return new Promise((resolve) => {
    const dialog = el('dialog', { className: 'password-dialog', 'aria-labelledby': 'pw-title' });
    const body = el('div', { className: 'password-body' });

    body.append(el('h2', { id: 'pw-title', text: title }));
    if (message) body.append(el('p', { className: 'muted', text: message }));

    const first = el('input', {
      type: 'password',
      id: 'pw-first',
      autocomplete: confirm ? 'new-password' : 'current-password',
      // Password managers and autocorrect both do the wrong thing to a passphrase.
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
    });
    body.append(el('label', { for: 'pw-first', text: 'Password' }), first);

    let second = null;
    if (confirm) {
      second = el('input', {
        type: 'password',
        id: 'pw-second',
        autocomplete: 'new-password',
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
      });
      body.append(el('label', { for: 'pw-second', text: 'Confirm password' }), second);
    }

    const error = el('p', { className: 'password-error', role: 'alert' });
    body.append(error);

    const actions = el('div', { className: 'password-actions' });
    const cancel = el('button', { type: 'button', className: 'quiet', text: 'Cancel' });
    const submit = el('button', { type: 'button', className: 'primary', text: submitLabel });
    actions.append(cancel, submit);
    body.append(actions);

    dialog.append(body);
    document.body.append(dialog);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      // Clear the fields before the nodes go anywhere a devtools inspection could reach.
      first.value = '';
      if (second) second.value = '';
      dialog.close();
      dialog.remove();
      resolve(value);
    };

    const attempt = () => {
      const value = first.value;
      if (!value) {
        error.textContent = 'Enter a password.';
        first.focus();
        return;
      }
      if (confirm) {
        if (value.length < minLength) {
          error.textContent = `Use at least ${minLength} characters. `
            + 'A short password is the weakest part of any encryption.';
          return;
        }
        if (second && second.value !== value) {
          error.textContent = 'The two passwords do not match.';
          second.focus();
          return;
        }
      }
      finish(value);
    };

    submit.addEventListener('click', attempt);
    cancel.addEventListener('click', () => finish(null));
    // Escape, and the backdrop click browsers route through `cancel`.
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });

    for (const input of [first, second]) {
      input?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          attempt();
        }
      });
    }

    dialog.showModal();
    first.focus();
  });
}
