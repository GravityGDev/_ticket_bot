const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const discord = require('discord.js');
const source = fs.readFileSync(path.join(__dirname, '../src/ticket-system.js'), 'utf8');
const section = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const quiet = { log() {}, warn() {}, error() {} };
function load(extra = {}) {
  const context = { ...discord, console: quiet, ...extra };
  vm.createContext(context);
  vm.runInContext(
    section('function getTicketButtons(', 'function normalizeTicketChannelLabel(') +
    section('function messageHasButton(', 'function isTicketClosedForCreator(') +
    section('function isTicketControlMessage(', 'function getBottomPositionForCategory('), context);
  return context;
}
function welcome(id = 'welcome', number = 370, author = 'bot') {
  return { id, author: { id: author }, embeds: [{ footer: { text: `Ticket #${number} • Created by customer` } }], components: [],
    edit: async function(payload) { this.components = payload.components.map(row => row.toJSON ? row.toJSON() : row); } };
}
function channel(pinned, pages = []) {
  const requests = [];
  return { id: 'ticket', client: { user: { id: 'bot' } }, requests,
    messages: { fetchPinned: async () => new discord.Collection(pinned.map(m => [m.id, m])),
      fetch: async query => {
        requests.push(query);
        if (typeof query === 'string') throw Error('deleted');
        return new discord.Collection((pages.shift() || []).map(m => [m.id, m]));
      } },
  };
}

test('recovers buttonless pinned welcome after closing with missing or stale stored ID', async () => {
  const api = load();
  for (const controlMessageId of [null, 'deleted']) {
    const original = welcome();
    const c = channel([welcome('wrong-ticket', 3700), welcome('wrong-author', 370, 'human'), original]);
    assert.equal(await api.findTicketControlMessage(c, { number: 370, controlMessageId }), original);
  }
});

test('finds old unpinned welcome beyond the latest page and ignores closed controls', async () => {
  const api = load();
  const original = welcome();
  const recent = Array.from({ length: 100 }, (_, n) => ({ id: String(1000 - n), author: { id: 'human' } }));
  const closed = welcome('closed');
  closed.components = [{ components: [{ customId: 'ticket_reopen' }] }];
  const c = channel([closed], [recent, [original]]);
  assert.equal(await api.findTicketControlMessage(c, { number: 370 }), original);
  assert.equal(c.requests[1].before, '901');
});

test('restores claimed and unclaimed buttons, retains ownership and saves recovered welcome ID', async () => {
  for (const claimedById of [null, 'claimer']) {
    const original = welcome();
    const data = { typeKey: 'bug_report', number: 370, claimedById, assistStaffIds: ['assistant'] };
    let saved;
    const api = load({ updateTicketTopic: async (c, d, patch) => { saved = patch; } });
    assert.equal(await api.refreshTicketControlMessage(channel([original]), data), true);
    const ids = original.components.flatMap(row => row.components.map(b => b.custom_id));
    assert.deepEqual(Array.from(ids), ['ticket_close', claimedById ? 'ticket_assist' : 'ticket_claim', 'ticket_role', 'ticket_rename']);
    assert.equal(data.claimedById, claimedById);
    assert.deepEqual(data.assistStaffIds, ['assistant']);
    assert.equal(saved.controlMessageId, original.id);
  }
});

test('Report Staff recovers Close only; normal refresh preserves existing extra rows without duplicate Rename', async () => {
  const api = load({ updateTicketTopic: async () => {} });
  const report = welcome();
  await api.refreshTicketControlMessage(channel([report]), { typeKey: 'report_staff', number: 370 });
  assert.deepEqual(Array.from(report.components.flatMap(row => row.components.map(b => b.custom_id))), ['ticket_close']);
  const original = welcome();
  const extra = new discord.ActionRowBuilder().addComponents(new discord.ButtonBuilder().setCustomId('extra').setLabel('Extra').setStyle(2)).toJSON();
  original.components = [api.getTicketButtons('bug_report').toJSON(), extra, api.getTicketRenameButtonRow().toJSON()];
  // Discord message components expose customId (unlike serialized builders).
  original.components = original.components.map(row => ({ ...row, components: row.components.map(b => ({ ...b, customId: b.custom_id })) }));
  await api.refreshTicketControlMessage(channel([original]), { typeKey: 'bug_report', number: 370 });
  const ids = original.components.flatMap(row => row.components.map(b => b.custom_id));
  assert.equal(ids.filter(id => id === 'ticket_rename').length, 1);
  assert.ok(ids.includes('extra'));
});

async function reopen({ found = true, editFailure = false, typeKey = 'bug_report', reported = false } = {}) {
  const calls = [];
  const data = { number: 370, typeKey, creatorId: 'creator', closedAt: 'closed', claimedById: 'claimer', reportedStaffId: reported ? 'staff' : null };
  const context = { ...discord, console: quiet,
    getTicketData: () => data, getLiveTicketData: async () => data, messageHasButton: () => true,
    isStaffForTicket: () => true, TICKET_TYPES: { bug_report: { slug: 'bug-report' }, report_staff: { slug: 'report-staff' } },
    buildTicketChannelName: () => 'ticket-370_bug-report', TICKET_NAME_PREFIX: 'ticket-', shouldCreatorBeUnlocked: () => true,
    setCreatorTyping: async () => calls.push('access'), applyTicketStaffTypingState: async () => {},
    refreshTicketControlMessage: async () => { calls.push('restore'); if (editFailure) throw Error('edit denied'); return found; },
    requestTicketChannelRename: () => calls.push('rename'),
    updateTicketTopic: async (channel, d, patch) => { calls.push('save'); Object.assign(data, patch); },
  };
  vm.createContext(context);
  vm.runInContext(section('async function reopenTicket(', 'function escapeHtml('), context);
  await context.reopenTicket({
    channel: { id: 'ticket', send: async () => calls.push('notify'), permissionOverwrites: { edit: async () => calls.push('rollback') } },
    guild: { members: { fetch: async () => ({ permissions: { has: () => true } }) } },
    user: { id: 'staff', tag: 'Staff' },
    message: { delete: async () => calls.push('delete-closed'), edit: async () => {} },
    reply: async () => {}, editReply: async text => calls.push(text),
  });
  return { calls, data };
}

test('reopen restores buttons before deleting closed controls and clearing closed state', async () => {
  for (const typeKey of ['bug_report', 'report_staff']) {
    const { calls, data } = await reopen({ typeKey });
    assert.ok(calls.indexOf('restore') < calls.indexOf('delete-closed'));
    assert.ok(calls.includes('notify'));
    assert.equal(data.closedAt, null);
    assert.equal(data.claimedById, 'claimer');
  }
});

test('missing controls or failed edits retain closed controls and report a retryable failure', async () => {
  for (const options of [{ found: false }, { editFailure: true }]) {
    const { calls, data } = await reopen(options);
    assert.ok(calls.includes('rollback'));
    assert.equal(calls.includes('delete-closed'), false);
    assert.equal(calls.includes('notify'), false);
    assert.equal(data.closedAt, 'closed');
  }
  const denied = await reopen({ typeKey: 'report_staff', reported: true });
  assert.equal(denied.calls.includes('restore'), false);
});
