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
