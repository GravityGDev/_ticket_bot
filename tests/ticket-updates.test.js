const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let muteRecord = null;
const muteCollection = {
  async findOne() { return muteRecord; },
  async updateOne(_query, update) { muteRecord = update.$set; },
  async deleteOne() { const deletedCount = muteRecord ? 1 : 0; muteRecord = null; return { deletedCount }; },
};
const accessModule = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/ticket-access.js'), 'utf8'), {
  module: accessModule,
  require: () => ({ getMongoDb: async () => ({ collection: () => muteCollection }) }),
  Date, Number, String, Math,
});
const access = accessModule.exports;

test('durations distinguish minutes and calendar months, and support combinations', () => {
  const now = new Date('2026-01-31T10:00:00Z');
  assert.equal(access.parseTicketMuteExpiry('1m', now).toISOString(), '2026-01-31T10:01:00.000Z');
  assert.equal(access.parseTicketMuteExpiry('1mon', now).toISOString(), '2026-02-28T10:00:00.000Z');
  assert.equal(access.parseTicketMuteExpiry('1w 6d 24h', now).getTime() - now.getTime(), 14 * 86400000);
  assert.equal(access.parseTicketMuteExpiry('permanently', now), null);
  for (const invalid of ['', '0d', '-1d', '1year', 'garbage1d', '1d garbage', '1.5d', '9999999999999999999999mon']) {
    assert.throws(() => access.parseTicketMuteExpiry(invalid, now));
  }
});

test('creation opens exactly four days after joining', async () => {
  muteRecord = null;
  const joined = Date.parse('2026-10-01T12:00:00Z');
  const member = { id: 'user', joinedTimestamp: joined };
  assert.match(await access.ticketCreationDenial({ id: 'guild' }, member, joined + access.FOUR_DAYS_MS - 1), /4 days/);
  assert.equal(await access.ticketCreationDenial({ id: 'guild' }, member, joined + access.FOUR_DAYS_MS), null);
  assert.match(await access.ticketCreationDenial({ id: 'guild' }, null), /could not verify/);
});

test('permanent and timed mutes block admission, expiry and unmute restore it', async () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  const member = { id: 'user', joinedTimestamp: now - 5 * 86400000 };
  await access.setTicketMute('guild', 'user', null, 'actor', 'test');
  assert.match(await access.ticketCreationDenial({ id: 'guild' }, member, now), /permanently/);
  await access.setTicketMute('guild', 'user', new Date(now + 60000), 'actor');
  assert.match(await access.ticketCreationDenial({ id: 'guild' }, member, now), /until/);
  assert.equal(await access.ticketCreationDenial({ id: 'guild' }, member, now + 60000), null);
  await access.removeTicketMute('guild', 'user');
  assert.equal(await access.ticketCreationDenial({ id: 'guild' }, member, now), null);
});

function departureFixture({ present = false, conversation = true, archiveFails = false, membershipError = null, rejoined = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src/ticket-system.js'), 'utf8');
  const helper = source.slice(source.indexOf('const departedTicketJobs ='), source.indexOf('async function closeDepartedCreatorTickets('));
  const calls = [];
  let fetches = 0;
  const context = {
    deleteTicketChannel: (channel, method, user) => channel.delete(`SNAY_TICKET_DELETE:${method}:${user.id}`),
    Map, Date, String, Number, console: { log() {} },
    getLiveTicketData: async () => ({ creatorId: 'creator', number: 1, typeKey: 'general_inquiry' }),
    updateTicketTopic: async () => calls.push('close'),
    buildClosedTicketMessage: () => ({ embeds: [] }),
    requestTicketChannelRename: () => {},
    buildTicketChannelName: () => 'closed-ticket',
    getTicketChannelLabel: () => 'test',
    TICKET_TYPES: {}, CLOSED_TICKET_NAME_PREFIX: 'closed-',
    fetchAllChannelMessages: async () => conversation ? [{ author: { bot: false }, system: false }] : [{ author: { bot: true } }],
    sendTranscriptToLog: async () => { calls.push('archive'); if (archiveFails) throw Error('archive failed'); },
    liveTicketStateCache: new Map(), ticketRenameStates: new Map(),
    deleteTicketState: async () => calls.push('remove-state'),
  };
  vm.createContext(context);
  vm.runInContext(helper + '\nthis.cleanup = closeDepartedCreatorTicket;', context);
  const channel = {
    id: 'ticket',
    client: { user: { id: 'bot' } },
    guild: { members: { async fetch() {
      fetches++;
      if (membershipError) throw membershipError;
      if (present || (rejoined && fetches > 1)) return {};
      throw Object.assign(Error('Unknown Member'), { code: 10007 });
    } } },
    async send() { calls.push('notice'); },
    async delete() { calls.push('delete'); },
  };
  return { run: () => context.cleanup(channel), calls };
}

test('departed creator with conversation closes, archives then deletes', async () => {
  const fixture = departureFixture();
  assert.equal(await fixture.run(), true);
  assert.deepEqual(fixture.calls, ['close', 'notice', 'archive', 'delete', 'remove-state']);
});

test('empty tickets close without deleting', async () => {
  const fixture = departureFixture({ conversation: false });
  await fixture.run();
  assert.deepEqual(fixture.calls, ['close', 'notice']);
});

test('present creators and member-fetch failures cannot delete tickets', async () => {
  const present = departureFixture({ present: true });
  assert.equal(await present.run(), false);
  assert.deepEqual(present.calls, []);
  const failed = departureFixture({ membershipError: Object.assign(Error('network'), { code: 50013 }) });
  await assert.rejects(failed.run());
  assert.deepEqual(failed.calls, []);
});

test('archive failure and rejoin prevent deletion', async () => {
  const failed = departureFixture({ archiveFails: true });
  await assert.rejects(failed.run());
  assert.equal(failed.calls.includes('delete'), false);
  const rejoined = departureFixture({ rejoined: true });
  await rejoined.run();
  assert.equal(rejoined.calls.includes('archive'), true);
  assert.equal(rejoined.calls.includes('delete'), false);
});

test('overlapping cleanup requests perform only one archive and deletion', async () => {
  const fixture = departureFixture();
  await Promise.all([fixture.run(), fixture.run()]);
  assert.equal(fixture.calls.filter(x => x === 'archive').length, 1);
  assert.equal(fixture.calls.filter(x => x === 'delete').length, 1);
});

test('staff point adjustment access includes editors and rejects other users', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/staff-tracking.js'), 'utf8');
  const helper = source.slice(source.indexOf('async function canAdjustStaffPointsMember('), source.indexOf('function buildPointAdjustmentRow('));
  const context = { Boolean, PermissionFlagsBits: { Administrator: 'admin' }, canManageStaffSettings: async (_guild, user) => user === 'editor' };
  vm.createContext(context);
  vm.runInContext(helper + '\nthis.check = canAdjustStaffPointsMember;', context);
  const member = (id, admin = false) => ({ id, guild: { id: 'guild' }, permissions: { has: () => admin } });
  assert.equal(await context.check(member('editor')), true);
  assert.equal(await context.check(member('admin', true)), true);
  assert.equal(await context.check(member('other')), false);
  assert.equal(await context.check(null), false);
});

test('point deductions use existing overrides or automatic totals and clamp to zero', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/staff-tracking.js'), 'utf8');
  const start = source.indexOf('      let value = null;', source.indexOf("action === 'pointmodal'"));
  const end = source.indexOf('      await setStaffPointOverride(', start);
  const body = source.slice(start, end);
  const calculate = new Function('rawValue', 'pointType', 'override', 'interaction', `
    return (async () => {
      const periodKey = 'weekly', memberId = 'staff';
      const getStaffSnapshot = async () => ({ claimCounts: new Map([['staff', 3]]), messageCounts: new Map([['staff', 20]]) });
      const getStaffTrackingSettings = async () => ({ ticketClaimPoints: 0.5, trackedMessagePoints: 1 });
      const getStaffPointOverridesForPeriod = async () => new Map([['staff', override]]);
      ${body}
      return { value, removedAmount };
    })();
  `);
  const interaction = { guild: { id: 'guild' }, followUp: async () => {} };
  assert.deepEqual(await calculate('-0.5', 'ticket', null, interaction), { value: 1, removedAmount: 0.5 });
  assert.deepEqual(await calculate('-10', 'message', { messagePoints: 50 }, interaction), { value: 40, removedAmount: 10 });
  assert.deepEqual(await calculate('-999', 'ticket', null, interaction), { value: 0, removedAmount: 1.5 });
  assert.deepEqual(await calculate('AUTO', 'ticket', null, interaction), { value: null, removedAmount: null });
});

test('normal ticket delete accepts the developer or designated role', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/ticket-system.js'), 'utf8');
  const body = source.slice(source.indexOf('async function deleteTicket('), source.indexOf('async function claimTicket('));
  const condition = body.match(/if \(\s*(data\.typeKey !== 'report_staff'[\s\S]*?)\s*\) \{\s*await interaction\.reply/)[1];
  const denied = new Function('data', 'interaction', 'member', 'isBotDeveloper', 'NORMAL_TICKET_DELETE_ROLE_ID', `return (${condition});`);
  const developer = user => user.id === '1150135578378125383';
  const check = (id, role, typeKey = 'general_inquiry') => denied({ typeKey }, { user: { id } }, { roles: { cache: { has: () => role } } }, developer, '950141448307740672');
  assert.equal(check('1150135578378125383', false), false);
  assert.equal(check('admin', true), false);
  assert.equal(check('other', false), true);
  // Report Staff deletion continues through its earlier dedicated checks.
  assert.equal(check('other', false, 'report_staff'), false);
});
