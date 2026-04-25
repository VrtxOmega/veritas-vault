#!/usr/bin/env node
/**
 * VERITAS VAULT — Launch Script
 * 
 * Strips ELECTRON_RUN_AS_NODE from the environment before spawning
 * electron.exe so it boots as a proper Main Process, not as Node.js.
 * (Same pattern as SovereignSpeak / Gravity Omega launch.js)
 */
const { spawn } = require('child_process');
const electronPath = require('electron');

// Clone env and strip the contaminant
const cleanEnv = Object.assign({}, process.env);
delete cleanEnv.ELECTRON_RUN_AS_NODE;

const args = ['.', '--enable-logging'];
if (process.argv.includes('--dev')) {
    args.unshift('--enable-logging', '--inspect');
}

console.log('[VeritasVault] Igniting...');
const child = spawn(electronPath, args, {
    cwd: __dirname,
    env: cleanEnv,
    stdio: 'inherit',
});

child.on('close', (code) => process.exit(code || 0));
