'use strict';

const path = require('node:path');

// Local runs: <repo>/.env fills in the variables the shell has not set (one that is already
// set, such as Railway's, wins). Only entry points call this (`node server.js`, the scripts),
// never a module that is merely required, so a test run cannot reach whatever database or
// bucket a .env names. -> true when a file was loaded, false when there is none.
function loadDotEnv(file = path.join(__dirname, '..', '.env')) {
  try {
    process.loadEnvFile(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

module.exports = { loadDotEnv };
