#!/usr/bin/env node
// Medusa startup profiler - logs timing for each initialization step
const { performance } = require('perf_hooks');
const Module = require('module');
const originalRequire = Module.prototype.require;

const times = [];
const start = performance.now();

function log(msg) {
    const elapsed = (performance.now() - start).toFixed(0);
    console.log(`[${elapsed}ms] ${msg}`);
    times.push({ time: elapsed, message: msg });
}

// Intercept module loading to see what's slow
Module.prototype.require = function (id) {
    if (id.includes('ioredis') || id.includes('postgres') || id.includes('pg')) {
        const reqStart = performance.now();
        const result = originalRequire.apply(this, arguments);
        const reqTime = (performance.now() - reqStart).toFixed(0);
        if (reqTime > 100) {
            log(`SLOW REQUIRE: ${id} took ${reqTime}ms`);
        }
        return result;
    }
    return originalRequire.apply(this, arguments);
};

log('Starting Medusa profiler');

// Start medusa
require('@medusajs/medusa-cli/dist/commands/develop').default;
