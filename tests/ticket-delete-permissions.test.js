const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const discord = require('discord.js');
const hierarchy = require('../src/staff-role-hierarchy');

function fixture() {
  const records = new Map();
  function load() {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/staff-command-permissions.js'), 'utf8'), {
      module, Buffer, console: { log() {} },
      require: name => {
        if (name === 'discord.js') return discord;
        if (name === './staff-role-hierarchy') return hierarchy;
        if (name === './staff-settings-store') return { canManageStaffSettings: async () => false };
        if (name === './database') return { getMongoDb: async () => ({ collection: () => ({
          find: query => ({ toArray: async () => [...records.values()].filter(row => row.guildId === query.guildId) }),
          updateOne: async (query, update) => records.set(query._id, { _id: query._id, ...update.$set }),
          deleteOne: async query => ({ deletedCount: records.delete(query._id) ? 1 : 0 }),
        }) }) };
        throw Error(name);
      },
    });
    return module.exports;
  }
  const guild = { id: 'guild', roles: { cache: new Map(hierarchy.STAFF_ROLE_IDS.map((id, index) => [id, { id, name: `Role ${index}` }])) } };
  const member = (index, { id = 'staff', admin = false } = {}) => ({
    id, guild, roles: { cache: new Map(index < 0 ? [] : [[hierarchy.STAFF_ROLE_IDS[index], {}]]) },
    permissions: { has: flag => flag === discord.PermissionFlagsBits.Administrator && admin },
  });
  return { api: load(), reload: load, records, guild, member };
}

test('delete actions keep prior defaults until configured and always allow the developer', async () => {
  const f = fixture();
  const normal = f.api.ticketDeletePermissionKey('general_inquiry');
  const report = f.api.ticketDeletePermissionKey('report_staff');
  assert.equal(await f.api.canMemberUseCommand(f.member(9), normal), true);
  assert.equal(await f.api.canMemberUseCommand(f.member(10), normal), false);
  assert.equal(await f.api.canMemberUseCommand(f.member(-1, { admin: true }), report), true);
  assert.equal(await f.api.canMemberUseCommand(f.member(9), report), false);
  assert.equal(await f.api.canMemberUseCommand(f.member(-1, { id: hierarchy.BOT_DEVELOPER_USER_ID }), normal), true);
});

test('configured deletion roles inherit upward, persist on reload and remain separate', async () => {
  const f = fixture();
  const normal = f.api.ticketDeletePermissionKey('bug_report');
  const report = f.api.ticketDeletePermissionKey('report_staff');
  await f.api.setMinimumRole('guild', normal, 3, 'developer');
  assert.equal(await f.api.canMemberUseCommand(f.member(2), normal), false);
  assert.equal(await f.api.canMemberUseCommand(f.member(3), normal), true);
  assert.equal(await f.api.canMemberUseCommand(f.member(10), normal), true);
  assert.equal(await f.api.canMemberUseCommand(f.member(3), report), false);
  const restarted = f.reload();
  assert.equal(await restarted.canMemberUseCommand(f.member(3), normal), true);
  await restarted.setMinimumRole('guild', report, 5, 'developer');
  assert.equal(await restarted.canMemberUseCommand(f.member(5), report), true);
  assert.equal(await restarted.canMemberUseCommand(f.member(-1, { admin: true }), report), false);
});

test('Developer only denies staff and administrators; Reset restores historic defaults', async () => {
  const f = fixture();
  for (const type of ['general_inquiry', 'report_staff']) {
    const key = f.api.ticketDeletePermissionKey(type);
    await f.api.setMinimumRole('guild', key, null, 'developer');
    assert.equal(await f.api.canMemberUseCommand(f.member(10, { admin: true }), key), false);
    assert.equal(await f.api.canMemberUseCommand(f.member(-1, { id: hierarchy.BOT_DEVELOPER_USER_ID }), key), true);
    await f.api.resetMinimumRole('guild', key);
  }
  assert.equal(await f.api.canMemberUseCommand(f.member(9), f.api.ticketDeletePermissionKey('bug_report')), true);
  assert.equal(await f.api.canMemberUseCommand(f.member(-1, { admin: true }), f.api.ticketDeletePermissionKey('report_staff')), true);
});

test('/permissions renders both editable Delete actions without registering slash commands', async () => {
  const f = fixture();
  let payload;
  await f.api.sendPermissionPanel({
    inGuild: () => true, guild: f.guild, user: { id: hierarchy.BOT_DEVELOPER_USER_ID },
    deferReply: async () => {}, editReply: async value => { payload = value; },
  }, { commands: new Map() });
  const options = payload.components[0].toJSON().components[0].options;
  assert.equal(options.length, 2);
  assert.ok(options.some(option => option.label === 'Delete normal tickets (button)'));
  assert.ok(options.some(option => option.label === 'Delete Report Staff tickets (button)'));
});

async function runDelete(f, member, data) {
  const source = fs.readFileSync(path.join(__dirname, '../src/ticket-system.js'), 'utf8');
  const calls = [];
  const i = {
    user: { id: member.id, username: 'staff' }, guild: { members: { fetch: async () => { assert.equal(calls[0], 'ack'); return member; } } },
    channel: { id: 'ticket' }, message: { edit: async () => calls.push('edit') },
    deferUpdate: async () => calls.push('ack'), followUp: async response => calls.push(response.content),
  };
  const context = {
    getTicketData: () => data, getLiveTicketData: async () => data, messageHasButton: () => true,
    canMemberUseCommand: f.api.canMemberUseCommand, ticketDeletePermissionKey: f.api.ticketDeletePermissionKey,
    isBotDeveloper: hierarchy.isBotDeveloper,
    getClosedByIdFromControlMessage: () => null, getClosedAtFromControlMessage: () => null,
    EmbedBuilder: discord.EmbedBuilder, MessageFlags: discord.MessageFlags, PermissionFlagsBits: discord.PermissionFlagsBits,
    DELETE_COUNTDOWN_SECONDS: 0, delay: async () => {},
    sendTranscriptToLog: async () => calls.push('archive'), deleteTicketChannel: async () => calls.push('delete'),
    deleteTicketState: async () => {}, console, TRANSCRIPT_LOG_CHANNEL_ID: 'logs',
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function deleteTicket('), source.indexOf('\nasync function claimTicket(')) + '\nthis.run = deleteTicket;', context);
  await context.run(i);
  return calls;
}

test('Delete button enforces configured access before archiving or deleting', async () => {
  const f = fixture();
  const data = { typeKey: 'general_inquiry', number: 1 };
  await f.api.setMinimumRole('guild', f.api.ticketDeletePermissionKey(data.typeKey), 4, 'developer');
  const denied = await runDelete(f, f.member(3), data);
  assert.equal(denied.includes('delete'), false);
  assert.equal(denied.includes('archive'), false);
  assert.match(denied[1], /permissions/);
  const allowed = await runDelete(f, f.member(4), data);
  assert.ok(allowed.includes('archive'));
  assert.ok(allowed.includes('delete'));
});

test('reported user is blocked even when their role or developer account has deletion access', async () => {
  const f = fixture();
  const key = f.api.ticketDeletePermissionKey('report_staff');
  await f.api.setMinimumRole('guild', key, 0, 'developer');
  for (const id of ['staff', hierarchy.BOT_DEVELOPER_USER_ID]) {
    const calls = await runDelete(f, f.member(10, { id }), { typeKey: 'report_staff', reportedStaffId: id, number: 1 });
    assert.equal(calls.includes('delete'), false);
    assert.match(calls[1], /reporting you/);
  }
  const allowed = await runDelete(f, f.member(0), { typeKey: 'report_staff', reportedStaffId: 'other', number: 1 });
  assert.ok(allowed.includes('delete'));
});
