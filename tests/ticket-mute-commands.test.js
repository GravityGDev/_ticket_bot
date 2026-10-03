const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const discord = require('discord.js');
const access = require('../src/ticket-access');

function load(file, dependencies) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module, require: name => dependencies[name], console: { error() {} },
  });
  return module.exports;
}

function interaction(commandName, { duration = '5m', authorized = true, guild = true } = {}) {
  const calls = [];
  return {
    calls, commandName, guild: guild ? { id: 'guild' } : null,
    user: { id: 'developer' }, __snayPermissionAuthorized: authorized,
    inGuild() { return Boolean(this.guild); },
    options: {
      getString: name => name === 'duration' ? duration : 'too old',
      getUser: () => ({ id: 'developer' }),
    },
    async deferReply(response) {
      assert.equal(this.deferred, undefined, 'must acknowledge only once');
      this.deferred = true;
      calls.push(['defer', response]);
    },
    async reply(response) { assert.ok(!this.deferred); calls.push(['reply', response]); },
    async editReply(response) { assert.ok(this.deferred); calls.push(['edit', response]); },
  };
}

function command(name, overrides = {}) {
  return load(`src/commands/${name}.js`, {
    'discord.js': discord, '../ticket-access': { ...access, ...overrides },
  });
}

function authorization(i, { allowed = true, member = true } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src/staff-command-permissions.js'), 'utf8');
  const context = {
    MessageFlags: discord.MessageFlags,
    loadGuildCommandPermissions: async () => { assert.equal(i.deferred, true); },
    commandKeyFromInteraction: () => `chat:${i.commandName}`,
    canMemberUseCommandSync: () => allowed,
    getHighestStaffRoleIndex: () => 10,
    getMinimumRoleSync: () => 10,
    ADMINISTRATOR_ONLY_COMMANDS: new Set(), STAFF_ROLE_IDS: ['staff'],
    commandDisplayName: key => key,
  };
  if (i.guild) i.guild.members = { fetch: async () => {
    assert.equal(i.deferred, true, 'acknowledge before network fetch');
    return member ? {} : null;
  } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function authorizeApplicationCommand('), source.indexOf('\nasync function initializeGuildPermissions(')) + '\nthis.authorize = authorizeApplicationCommand;', context);
  return context.authorize(i);
}

test('self-mute with 5m acknowledges before authorization and saves expiry and reason', async () => {
  const i = interaction('ticket-mute', { authorized: false });
  const before = Date.now();
  let saved;
  assert.equal(await authorization(i), true);
  await command('ticket-mute', { setTicketMute: async (...args) => { saved = args; } }).execute(i);
  assert.deepEqual(saved.slice(0, 2), ['guild', 'developer']);
  assert.ok(saved[2].getTime() >= before + 300000);
  assert.ok(saved[2].getTime() <= Date.now() + 300000);
  assert.deepEqual(saved.slice(3), ['developer', 'too old']);
  assert.deepEqual(i.calls.map(c => c[0]), ['defer', 'edit']);
  assert.match(i.calls[1][1].content, /until <t:/);
});

test('invalid durations edit the deferred response without writing', async () => {
  const i = interaction('ticket-mute', { duration: 'bad' });
  await authorization(i);
  await command('ticket-mute', { setTicketMute: async () => assert.fail('must not write') }).execute(i);
  assert.deepEqual(i.calls.map(c => c[0]), ['defer', 'edit']);
  assert.match(i.calls[1][1].content, /duration/);
});

test('permanent mutes store null expiry', async () => {
  const i = interaction('ticket-mute', { duration: 'permanent' });
  await command('ticket-mute', { setTicketMute: async (_guild, _user, expiry) => assert.equal(expiry, null) }).execute(i);
  assert.match(i.calls[1][1].content, /permanently/);
});

test('authorization denials, missing members and DMs complete deferred responses', async () => {
  for (const options of [{ allowed: false }, { member: false }, { guild: false }]) {
    const i = interaction('ticket-mute', options);
    assert.equal(await authorization(i, options), false);
    assert.deepEqual(i.calls.map(c => c[0]), ['defer', 'edit']);
  }
});

test('mute and unmute database failures return actionable errors without success', async () => {
  for (const name of ['ticket-mute', 'ticket-unmute']) {
    const i = interaction(name);
    await authorization(i);
    const fail = async () => { throw Error('database unavailable'); };
    await command(name, { setTicketMute: fail, removeTicketMute: fail }).execute(i);
    assert.deepEqual(i.calls.map(c => c[0]), ['defer', 'edit']);
    assert.match(i.calls[1][1].content, /MongoDB/);
  }
});

test('unmute handles stored and missing mutes without double acknowledgement', async () => {
  for (const deletedCount of [0, 1]) {
    const i = interaction('ticket-unmute');
    await authorization(i);
    await command('ticket-unmute', { removeTicketMute: async () => ({ deletedCount }) }).execute(i);
    assert.deepEqual(i.calls.map(c => c[0]), ['defer', 'edit']);
    assert.match(i.calls[1][1].content, deletedCount ? /Removed/ : /no ticket-creation mute/);
  }
});

test('unauthorized calls cannot change mute state', async () => {
  for (const name of ['ticket-mute', 'ticket-unmute']) {
    const i = interaction(name, { authorized: false });
    const fail = async () => assert.fail('must not write');
    await command(name, { setTicketMute: fail, removeTicketMute: fail }).execute(i);
    assert.equal(i.calls.length, 0);
  }
});
