const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));

test('vercel crons run at most once a day (Hobby plan limit)', () => {
  assert.ok(Array.isArray(vercel.crons) && vercel.crons.length > 0);
  for (const cron of vercel.crons) {
    const [minute, hour, dom, month, dow] = cron.schedule.trim().split(/\s+/);
    assert.match(minute, /^\d+$/, `minute must be fixed: ${cron.schedule}`);
    assert.match(hour, /^\d+$/, `hour must be fixed: ${cron.schedule}`);
    assert.equal(dom, '*');
    assert.equal(month, '*');
    assert.equal(dow, '*');
  }
});

test('server function has a bounded maxDuration and pinned Node major', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '22.x');
  const serverBuild = vercel.builds.find((b) => b.src === 'server.js');
  assert.ok(serverBuild, 'server.js build entry');
  assert.equal(serverBuild.config.maxDuration, 30);
});

test('security overrides pin patched transitive versions', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const ver = (name) => lock.packages[`node_modules/${name}`]?.version || '0.0.0';
  const gte = (a, b) => {
    const x = a.split('.').map(Number); const y = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
    return true;
  };
  assert.equal(pkg.overrides['body-parser'], '1.20.8');
  assert.ok(gte(ver('proxy-addr'), '2.0.8'), `proxy-addr ${ver('proxy-addr')}`);
  assert.ok(gte(ver('qs'), '6.15.4'), `qs ${ver('qs')}`);
  assert.ok(gte(ver('body-parser'), '1.20.8'), `body-parser ${ver('body-parser')}`);
  assert.equal(ver('express').split('.')[0], '4', 'no major upgrade');
});
