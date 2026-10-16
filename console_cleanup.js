(function () {
  'use strict';

  // Keep the developer console focused on real errors. These messages are
  // diagnostics from the page or warnings emitted by development CDNs/libs.
  const noisyPrefixes = ['[RoboBlock]', '[ROB0]', '[SUMO]', '[RCSim]', '[STM]'];
  const noisyFragments = [
    'cdn.tailwindcss.com should not be used in production',
    'Blockly.Xml.textToDom was deprecated'
  ];

  function isNoise(args) {
    const first = args && args.length ? String(args[0]) : '';
    return noisyPrefixes.some(prefix => first.startsWith(prefix)) ||
      noisyFragments.some(fragment => first.includes(fragment));
  }

  ['log', 'info', 'debug', 'warn'].forEach(method => {
    const original = console[method];
    if (typeof original !== 'function') return;
    console[method] = function (...args) {
      if (isNoise(args)) return;
      return original.apply(this, args);
    };
  });
})();
