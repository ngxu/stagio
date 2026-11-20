// Picks the controller set for this operating system. Both expose the same objects
// (ppt, program, localMusic, output) so the server and the console don't care which one runs.
function create() {
  if (process.platform === 'darwin') return require('./mac').create(); // beta, see lib/platform/mac.js
  return require('./windows').create();
}

module.exports = { create };
