(function () {
  'use strict';

  // The buddy is optional. Keep an explicit user choice, but do not show it
  // on a fresh profile before the user enables it in Settings.
  if (!window._settings || typeof window._settings !== 'object') return;

  let hasExplicitChoice = false;
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key) continue;
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      if (value && Object.prototype.hasOwnProperty.call(value, 'buddyEnabled')) {
        hasExplicitChoice = true;
        break;
      }
    }
  } catch (error) {}

  if (!hasExplicitChoice) window._settings.buddyEnabled = false;
})();
