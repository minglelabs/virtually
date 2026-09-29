'use strict';

// Real provider adapters, keyed by provider id. The local test generator
// ("mock") is not listed here: lib/animate/registry.js adds it when enabled.
module.exports = {
  wavespeed: require('./wavespeed'),
  replicate: require('./replicate'),
  fal: require('./fal'),
  higgsfield: require('./higgsfield'),
  dashscope: require('./dashscope'),
  kling: require('./kling'),
};
