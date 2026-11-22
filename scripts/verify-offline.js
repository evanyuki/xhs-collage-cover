#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { comparePngBuffers } = require('./compare-png');

// The renderer child receives only the proof. The parent opens the reference PNG
// after the child exits, so the image being compared cannot serve as its input.
function verify(proofPath, originalPath, replayPath) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-cover-replay-'));
  const input = path.join(work, 'final.json');
  const output = path.join(work, 'replay.png');
  try {
    fs.copyFileSync(proofPath, input, fs.constants.COPYFILE_EXCL);
    execFileSync(process.execPath, [path.join(__dirname, 'render.js'), '--replay-only', 'final.json', 'replay.png'], {
      cwd: work, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit']
    });
    const replay = fs.readFileSync(output);
    const original = fs.readFileSync(originalPath);
    const comparison = comparePngBuffers(original, replay);
    if (comparison.identical && replayPath) {
      fs.mkdirSync(path.dirname(replayPath), { recursive: true });
      fs.writeFileSync(replayPath, replay);
    }
    return comparison;
  } finally {
    for (const file of [output, input]) fs.rmSync(file, { force: true });
    fs.rmdirSync(work);
  }
}

try {
  const files = process.argv.slice(2).map(file => path.resolve(file));
  if (files.length < 2 || files.length > 3) {
    throw new Error('用法：node scripts/verify-offline.js 定稿.json 原图.png [保存重绘.png]');
  }
  const keys = files.map(file => process.platform === 'win32' ? file.toLowerCase() : file);
  if (new Set(keys).size !== files.length) throw new Error('定稿、原图及重绘文件必须分开');
  const report = verify(...files);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.identical ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
