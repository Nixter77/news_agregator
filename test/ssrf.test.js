const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { isPrivateOrLocalHost, assertSafeDestination, assertSafeResolution, setDnsLookup } = require('../lib/net');

afterEach(() => setDnsLookup(null));

test('special-purpose IPv4 ranges are blocked', () => {
  for (const ip of ['100.64.0.1', '100.127.255.254', '198.18.0.1', '198.19.255.1', '192.0.0.8', '224.0.0.1', '255.255.255.255', '240.0.0.1']) {
    assert.equal(isPrivateOrLocalHost(ip), true, ip);
  }
  for (const ip of ['100.63.0.1', '100.128.0.1', '198.20.0.1', '8.8.8.8', '1.1.1.1']) {
    assert.equal(isPrivateOrLocalHost(ip), false, ip);
  }
});

test('IPv4-mapped IPv6 in hex form (as normalised by URL) is blocked', () => {
  assert.equal(new URL('http://[::ffff:127.0.0.1]/').hostname, '[::ffff:7f00:1]');
  assert.throws(() => assertSafeDestination('http://[::ffff:127.0.0.1]/'), /Blocked/);
  assert.throws(() => assertSafeDestination('http://[::ffff:a9fe:a9fe]/'), /Blocked/);
  assert.throws(() => assertSafeDestination('http://[::ffff:6440:1]/'), /Blocked/);
  assert.equal(isPrivateOrLocalHost('[::ffff:808:808]'), false);
});

test('hostnames resolving to private addresses are blocked', async () => {
  setDnsLookup(async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
  await assert.rejects(assertSafeResolution('https://rebind.example/feed'), /Blocked/);
  setDnsLookup(async () => [{ address: '::ffff:169.254.169.254', family: 6 }]);
  await assert.rejects(assertSafeResolution('https://meta.example/'), /Blocked/);
  setDnsLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
  await assert.doesNotReject(assertSafeResolution('https://public.example/'));
  setDnsLookup(async () => { throw new Error('ENOTFOUND'); });
  await assert.rejects(assertSafeResolution('https://nx.example/'), /DNS lookup failed/);
});

test('non-unicast IPv6 forms are blocked (ipaddr.js range + 2000::/3)', () => {
  const { isBlockedIp } = require('../lib/net');
  assert.throws(() => assertSafeDestination('http://[::7f00:1]/'), /Blocked/);
  assert.throws(() => assertSafeDestination('http://[2002:7f00:1::]/'), /Blocked/);
  assert.throws(() => assertSafeDestination('http://[fec0::1]/'), /Blocked/);
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', '2001::1', '2001:db8::1', '64:ff9b::a00:1', 'ff02::1']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  assert.equal(isBlockedIp('2a00:1450:4001:80b::200e'), false);
  assert.equal(isBlockedIp('8.8.8.8'), false);
  assert.equal(isBlockedIp('not-an-ip'), true);
});

test('pinned lookup returns only validated addresses and rejects rebinding', async () => {
  const { pinnedLookup } = require('../lib/net');
  const call = (host, opts) => new Promise((resolve, reject) => {
    pinnedLookup(host, opts, (err, addr, family) => (err ? reject(err) : resolve({ addr, family })));
  });
  setDnsLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
  assert.deepEqual(await call('public.example', {}), { addr: '93.184.216.34', family: 4 });
  const all = await call('public.example', { all: true });
  assert.deepEqual(all.addr, [{ address: '93.184.216.34', family: 4 }]);
  setDnsLookup(async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]);
  await assert.rejects(call('rebind.example', {}), /Blocked/);
  setDnsLookup(async () => [{ address: '::7f00:1', family: 6 }]);
  await assert.rejects(call('compat.example', {}), /Blocked/);
});

test('DNS check is never bypassed on Vercel even with NODE_ENV=test', async () => {
  const savedEnv = process.env.NODE_ENV;
  const savedVercel = process.env.VERCEL;
  process.env.NODE_ENV = 'test';
  process.env.VERCEL = '1';
  let resolved = 0;
  setDnsLookup(null);
  const dns = require('dns');
  const orig = dns.promises.lookup;
  dns.promises.lookup = async () => { resolved += 1; return [{ address: '127.0.0.1', family: 4 }]; };
  try {
    await assert.rejects(assertSafeResolution('https://looks-public.example/'), /Blocked/);
    assert.equal(resolved, 1);
  } finally {
    dns.promises.lookup = orig;
    process.env.NODE_ENV = savedEnv;
    if (savedVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = savedVercel;
  }
});
