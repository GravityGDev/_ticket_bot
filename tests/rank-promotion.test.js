const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const discord = require('discord.js');

function fixture({ authorized = true, staff = true, renderError = false } = {}) {
  const events = [];
  const module = { exports: {} };
  const member = { id: 'target', user: { bot: false, tag: 'Staff' } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/staff-rank-beta.js'), 'utf8') + `
    renderRankBetaCard = async (guild, member, period) => {
      record('render:' + period);
      if (renderError) throw new Error('database unavailable');
      return Buffer.from('card');
    };`, {
    module, Buffer, record: e => events.push(e), renderError,
    console: { log() {}, error() {} }, setTimeout() {},
    require(name) {
      if (name === 'discord.js') return discord;
      if (name === './rank-font-runtime') return { configureRankFonts() {} };
      if (name === './staff-role-hierarchy') return { isBotDeveloper: () => false, isStaffMember: () => staff };
      return {};
    },
  });
  const interaction = {
    inGuild: () => true, __snayPermissionAuthorized: authorized,
    memberPermissions: { has: () => false },
    user: { id: 'requester', tag: 'Requester' },
    options: { getUser: () => ({ id: 'target' }) },
    guild: { members: { fetch: async id => { events.push('fetch:' + id); return member; } } },
    reply: async data => events.push(data),
    deferReply: async () => events.push('defer'),
    editReply: async data => events.push(data),
  };
  return { events, interaction, send: module.exports.sendRankBetaCard };
}

test('configured staff can use promoted card and acknowledge before fetching selected member', async () => {
  const f = fixture();
  await f.send(f.interaction, 'monthly');
  assert.deepEqual(f.events.slice(0, 3), ['defer', 'fetch:target', 'render:monthly']);
  assert.equal(f.events[3].files[0].name, 'staff-rank-target-monthly.png');
});

test('unauthorized rank requests never fetch or render', async () => {
  const f = fixture({ authorized: false });
  await f.send(f.interaction);
  assert.equal(f.events.length, 1);
  assert.match(f.events[0].content, /View Audit Log/);
});

test('invalid targets and render errors finish the deferred response', async () => {
  const invalid = fixture({ staff: false });
  await invalid.send(invalid.interaction);
  assert.match(invalid.events[2].content, /isn't Snay.io staff/);
  const failed = fixture({ renderError: true });
  await failed.send(failed.interaction);
  assert.match(failed.events[3].content, /could not generate/);
});

test('rank command dispatches to promoted renderer and beta command is removed', async () => {
  let called;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/commands/rank.js'), 'utf8'), {
    module, require: name => name === 'discord.js' ? discord : {
      sendRankBetaCard: async (interaction, period) => { called = period; },
    },
  });
  assert.equal(module.exports.data.toJSON().name, 'rank');
  await module.exports.execute({ __snayPermissionAuthorized: true, options: { getString: () => null } });
  assert.equal(called, 'lifetime');
  assert.equal(fs.existsSync(path.join(__dirname, '../src/commands/rank-beta.js')), false);
  assert.equal(fs.readFileSync(path.join(__dirname, '../src/staff-command-permissions.js'), 'utf8').includes('chat:rank-beta'), false);
});
