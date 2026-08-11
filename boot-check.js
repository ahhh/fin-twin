/**
 * Boot watchdog.
 *
 * A CLASSIC script, deliberately — not a module. If `app.js` fails to load at all, nothing
 * inside it can report the problem, and the page sits on "Loading…" forever with no clue
 * why. This file always runs, so it can say what happened.
 *
 * The usual cause is opening index.html straight off disk. Over `file://` the browser
 * refuses ES module imports and `fetch`, both of which this app needs, so `app.js` never
 * executes a single line.
 */
(function () {
  'use strict';

  var GRACE_MS = 1500;

  function explain() {
    if (window.__fdtBooted) return;

    var status = document.getElementById('boot-status');
    if (!status) return;

    var fromDisk = window.location.protocol === 'file:';
    status.className = 'notice notice-error';
    status.textContent = '';

    var title = document.createElement('strong');
    title.textContent = fromDisk
      ? 'This page needs to be served, not opened from disk.'
      : 'The app did not start.';
    status.appendChild(title);

    var body = document.createElement('p');
    body.textContent = fromDisk
      ? 'Browsers block ES modules and data files over file:// for security reasons, so ' +
        'none of the app’s code was allowed to run. Start the little dev server and use ' +
        'the address it prints:'
      : 'Something stopped the scripts from loading. The browser console will say what.';
    status.appendChild(body);

    if (fromDisk) {
      var cmd = document.createElement('pre');
      cmd.className = 'boot-command';
      cmd.textContent = 'cd ' + 'fin_modeler' + '\nnode tools/serve.mjs\n\n→ http://localhost:8080';
      status.appendChild(cmd);

      var note = document.createElement('p');
      note.className = 'muted';
      note.textContent = 'No dependencies to install — the server is a single file with none.';
      status.appendChild(note);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(explain, GRACE_MS); });
  } else {
    setTimeout(explain, GRACE_MS);
  }
})();
