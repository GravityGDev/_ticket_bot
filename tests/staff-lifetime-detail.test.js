const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function storeFixture() {
  const seen = [];
  const rows = [{ staffId: 'staff', guildId: 'guild', claimedAt: new Date(), createdAt: new Date() }];
  function matches(filter) {
    const dateFilter = filter.claimedAt || filter.createdAt;
    // MongoDB comparison predicates compare within the operand's BSON type:
    // a Date does not match the old lifetime $gte:null predicate.
    if (dateFilter && !(dateFilter.$gte instanceof Date)) return [];
    return rows;
  }
  const collection = {
    createIndex: async () => {},
    countDocuments: async filter => { seen.push(filter); return matches(filter).length; },
    aggregate: pipeline => { const filter = pipeline[0].$match; seen.push(filter); return { toArray: async () => matches(filter) }; },
    find: filter => {
      seen.push(filter);
      const cursor = { sort: () => cursor, limit: () => cursor, toArray: async () => matches(filter) };
      return cursor;
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/staff-tracking-store.js'), 'utf8'), {
    module, Date, console: { log() {} },
    require: name => name === './database'
      ? { getMongoDb: async () => ({ collection: () => collection }) }
      : { DEFAULT_TRACKED_CATEGORY_IDS: [] },
  });
  return { api: module.exports, seen };
}

test('lifetime detail includes recorded Date activity in every total and breakdown', async () => {
  const { api, seen } = storeFixture();
  const detail = await api.getStaffDetail('guild', 'staff', 'lifetime');
  assert.equal(detail.start, null);
  assert.equal(detail.claimTotal, 1);
  assert.equal(detail.messageTotal, 1);
  for (const key of ['claimTypes', 'recentClaims', 'categoryRows', 'channelRows']) assert.equal(detail[key].length, 1);
  assert.equal(seen.length, 6);
  for (const filter of seen) {
    assert.equal(filter.guildId, 'guild');
    assert.equal(filter.staffId, 'staff');
    assert.equal('claimedAt' in filter, false);
    assert.equal('createdAt' in filter, false);
  }
});

test('rolling detail still applies a Date cutoff to all six queries', async () => {
  for (const period of ['weekly', 'monthly', 'quarterly']) {
    const { api, seen } = storeFixture();
    const detail = await api.getStaffDetail('guild', 'staff', period);
    assert.ok(detail.start instanceof Date);
    for (const filter of seen) assert.equal((filter.claimedAt || filter.createdAt).$gte, detail.start);
  }
});
