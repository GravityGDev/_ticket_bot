const test = require('node:test');
const assert = require('node:assert/strict');
const { createGuildMemberLoader } = require('../src/guild-member-cache');

function fixture(fetch) {
  let time = 1000;
  const warnings = [];
  const load = createGuildMemberLoader({ now: () => time, logger: { warn: text => warnings.push(text) } });
  const guild = { id: 'guild', members: { cache: new Map(), fetch } };
  return { guild, load, warnings, advance: ms => { time += ms; } };
}

test('concurrent features share one full fetch and reuse the live member cache', async () => {
  let calls = 0;
  let finish;
  const f = fixture(async options => {
    calls++;
    assert.equal(options.time, 15000);
    await new Promise(resolve => { finish = resolve; });
    f.guild.members.cache.set('staff', { id: 'staff' });
  });
  const requests = Array.from({ length: 20 }, () => f.load(f.guild));
  await Promise.resolve();
  assert.equal(calls, 1);
  finish();
  const results = await Promise.all(requests);
  assert.ok(results.every(value => value === f.guild.members.cache));
  f.guild.members.cache.set('joined', { id: 'joined' });
  assert.equal((await f.load(f.guild)).has('joined'), true);
  f.guild.members.cache.delete('staff');
  assert.equal((await f.load(f.guild)).has('staff'), false);
  assert.equal(calls, 1);
});

test('refresh expires after five minutes without repeated requests from panel clicks', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; });
  await f.load(f.guild);
  f.advance(299999);
  await f.load(f.guild);
  assert.equal(calls, 1);
  f.advance(1);
  await Promise.all([f.load(f.guild), f.load(f.guild)]);
  assert.equal(calls, 2);
});

test('gateway retry_after is respected and failed fetches are never treated as successful hydration', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('rate limited'), { name: 'GatewayRateLimitError', data: { retry_after: 90 } });
  });
  f.guild.members.cache.set('cached', {});
  assert.equal((await f.load(f.guild)).has('cached'), true);
  f.advance(90249);
  for (let i = 0; i < 20; i++) await f.load(f.guild);
  assert.equal(calls, 1);
  assert.equal(f.warnings.length, 1);
  f.advance(1);
  await f.load(f.guild);
  assert.equal(calls, 2);
});

test('short or malformed gateway limits and other failures receive a one-minute cooldown', async () => {
  for (const retry of [9.124, 2.012, undefined, 'invalid']) {
    let calls = 0;
    const f = fixture(async () => { calls++; throw Object.assign(new Error('failed'), { data: { retry_after: retry } }); });
    await f.load(f.guild);
    f.advance(59999);
    await f.load(f.guild);
    assert.equal(calls, 1);
    f.advance(1);
    await f.load(f.guild);
    assert.equal(calls, 2);
  }
});

test('one guild failure does not prevent another guild from loading', async () => {
  const f = fixture(async () => { throw Error('failed'); });
  await f.load(f.guild);
  let calls = 0;
  const other = { id: 'other', members: { cache: new Map(), fetch: async () => { calls++; } } };
  await f.load(other);
  assert.equal(calls, 1);
});
