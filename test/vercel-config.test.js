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
