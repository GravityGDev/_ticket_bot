const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ legacyExists = false } = {}) {
  const collections = new Map([['bot_settings', new Map([
    ['presence', { _id: 'presence', message: 'Here to support snay.io' }],
    ['ticket_assist:guild', { _id: 'ticket_assist:guild', roleIds: ['staff'] }],
  ])]]);
  if (legacyExists) collections.set('ticket_creation_mutes', new Map());
  const writes = [];
  const db = { collection(name) {
    return {
      async findOne(query) { return collections.get(name)?.get(query._id) || null; },
      async updateOne(query, update) {
        writes.push(name);
        if (!collections.has(name)) throw Error('cannot create a new collection -- already using 500 collections of 500');
        collections.get(name).set(query._id, { _id: query._id, ...update.$set });
      },
      async deleteOne(query) {
        return { deletedCount: collections.get(name)?.delete(query._id) ? 1 : 0 };
      },
    };
  } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/ticket-access.js'), 'utf8'), {
    module, require: () => ({ getMongoDb: async () => db }), Date,
  });
  return { access: module.exports, collections, writes };
}

test('mutes save and expire at Atlas collection limit without creating collections', async () => {
  const { access, collections, writes } = fixture();
  const now = new Date('2026-10-03T20:00:00Z');
  await access.setTicketMute('guild', 'user', access.parseTicketMuteExpiry('20m', now), 'developer', 'test');
  assert.equal((await access.getTicketMute('guild', 'user', now)).reason, 'test');
  assert.equal(await access.getTicketMute('guild', 'user', new Date('2026-10-03T20:20:00Z')), null);
  assert.deepEqual(writes, ['bot_settings']);
  assert.equal(collections.size, 1);
  assert.equal(collections.get('bot_settings').get('presence').message, 'Here to support snay.io');
  assert.deepEqual(collections.get('bot_settings').get('ticket_assist:guild').roleIds, ['staff']);
  assert.equal((await access.removeTicketMute('guild', 'user')).deletedCount, 1);
  assert.equal(await access.getTicketMute('guild', 'user', now), null);
  assert.equal(collections.size, 1);
});

test('legacy mutes remain effective and unmute removes both storage versions', async () => {
  const { access, collections } = fixture({ legacyExists: true });
  collections.get('ticket_creation_mutes').set('guild:user', { expiresAt: null, reason: 'legacy' });
  assert.equal((await access.getTicketMute('guild', 'user')).reason, 'legacy');
  await access.setTicketMute('guild', 'user', null, 'developer', 'current');
  assert.equal((await access.getTicketMute('guild', 'user')).reason, 'current');
  assert.equal((await access.removeTicketMute('guild', 'user')).deletedCount, 1);
  assert.equal(await access.getTicketMute('guild', 'user'), null);
});

test('expired current mutes do not reactivate older permanent mutes', async () => {
  const { access, collections } = fixture({ legacyExists: true });
  collections.get('ticket_creation_mutes').set('guild:user', { expiresAt: null });
  await access.setTicketMute('guild', 'user', new Date('2026-10-03T20:00:00Z'), 'developer');
  assert.equal(await access.getTicketMute('guild', 'user', new Date('2026-10-03T20:01:00Z')), null);
});

test('mute IDs isolate guilds and users; missing unmute creates no collection', async () => {
  const { access, collections } = fixture();
  await access.setTicketMute('guild', 'user', null, 'developer');
  assert.equal(await access.getTicketMute('other', 'user'), null);
  assert.equal(await access.getTicketMute('guild', 'other'), null);
  assert.equal((await access.removeTicketMute('guild', 'other')).deletedCount, 0);
  assert.equal(collections.size, 1);
});

function typingFixture(member) {
  const source = fs.readFileSync(path.join(__dirname, '../src/ticket-system.js'), 'utf8');
  const calls = [];
  const context = {
    OverwriteType: { Member: 1 }, PermissionFlagsBits: { SendMessages: 2048n },
    isTicketAdministrator: () => false, console: { warn() {}, error() {} },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function setTicketStaffTyping('), source.indexOf('\nasync function ensureTicketSpeakerPermission(')) + '\nthis.run = setTicketStaffTyping;', context);
  let permissionChecks = 0;
  const channel = {
    id: 'ticket', guild: { members: { cache: new Map(), fetch: async () => member } },
    permissionOverwrites: {
      async edit(target, overwrite, options) {
        assert.equal(options.type, 1, 'must specify Member for uncached user IDs');
        assert.equal(typeof options.reason, 'string');
        calls.push({ target, overwrite, options });
      },
      async delete() {},
    },
    permissionsFor: () => ({ has: () => ++permissionChecks > 1 }),
  };
  return { run: () => context.run(channel, 'departed-user', true, 'restore access'), calls };
}

test('ticket permission restoration explicitly types missing users as members', async () => {
  const f = typingFixture(null);
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].target, 'departed-user');
  assert.equal(f.calls[0].options.reason, 'restore access');
});

test('ticket permission rebuild keeps member type and audit reason', async () => {
  const member = { id: 'departed-user' };
  const f = typingFixture(member);
  await f.run();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].target, member);
  assert.match(f.calls[1].options.reason, /rebuilt assistant access/);
});
