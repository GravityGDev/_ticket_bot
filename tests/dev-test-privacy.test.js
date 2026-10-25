const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const discord = require('discord.js');
const hierarchy = require('../src/staff-role-hierarchy');
const source = fs.readFileSync(path.join(__dirname, '../src/ticket-system.js'), 'utf8');
const section = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
function load(extra = {}, sections = []) {
  const ctx = { ...discord, ...hierarchy, console: { log() {}, warn() {}, error() {} }, ...extra };
  vm.createContext(ctx);
  vm.runInContext(section('const TICKET_TYPES =', 'const YOUTUBE_RANGES =') +
    section('function buildDevTestPermissionOverwrites(', 'function buildReportStaffPermissionOverwrites(') + sections.join('\n'), ctx);
  return ctx;
}

test('only developer sees dev test option; ordinary ticket options stay available', () => {
  const api = load({ isTicketAdministrator: () => true }, [section('function buildTicketTypeMenu(', 'function buildYouTubeSubscriberMenu(')]);
  for (const id of ['customer', 'moderator', 'administrator', 'server-owner', hierarchy.BOT_DEVELOPER_USER_ID]) {
    const menu = api.buildTicketTypeMenu({ id });
    const values = menu.components[0].toJSON().components[0].options.map(option => option.value);
    assert.equal(values.includes('dev_test'), id === hierarchy.BOT_DEVELOPER_USER_ID);
    assert.ok(values.includes('bug_report'));
  }
});

test('stale or forged dev test selection is denied before config reads or channel creation', async () => {
  const api = load({ ticketCreationDenial: () => { throw Error('must reject before any creation work'); } },
    [section('async function createTicket(', 'function messageHasButton(')]);
  let reply;
  await api.createTicket({ user: { id: 'administrator' }, member: { roles: { cache: new Map() } }, guild: {},
    deferUpdate: async () => {}, editReply: async data => { reply = data; } }, 'dev_test');
  assert.match(reply.content, /only available to the bot developer/);
});

test('private permissions have only everyone deny plus developer and bot allows', async () => {
  const api = load();
  let overwrites;
  const c = { guild: { roles: { everyone: { id: 'everyone' } } }, client: { user: { id: 'bot' } },
    permissionOverwrites: { set: async next => { overwrites = next; } } };
  await api.repairDevTestPrivacy(c);
  assert.deepEqual(Array.from(overwrites, row => row.id), ['everyone', hierarchy.BOT_DEVELOPER_USER_ID, 'bot']);
  assert.equal(overwrites[0].deny, discord.PermissionFlagsBits.ViewChannel);
  assert.ok(overwrites[1].allow & discord.PermissionFlagsBits.ViewChannel);
});

test('startup replaces leaked member/role overwrites on open and closed test tickets', async () => {
  for (const closed of [false, true]) {
    const calls = [];
    const base = { typeKey: 'dev_test', creatorId: 'old-admin', closedAt: closed ? 'closed' : null };
    const api = load({ getTicketData: () => base, CLOSED_TICKET_NAME_PREFIX: 'closed-',
      refreshTicketControlMessage: async () => calls.push('controls') },
      [section('async function restoreOneTicketRuntimeState(', 'function assertTicketRuntimeHelpers(')]);
    const c = { name: closed ? 'closed-1_dev-test' : 'ticket-1_dev-test', guild: { roles: { everyone: { id: 'everyone' } } },
      client: { user: { id: 'bot' } }, permissionOverwrites: { set: async rows => calls.push(Array.from(rows, r => r.id)) } };
    const result = await api.restoreOneTicketRuntimeState(c, { assistStaffIds: ['old-staff'], claimedById: 'old-claimer' });
    assert.equal(result.restored, true);
    assert.deepEqual(calls[0], ['everyone', hierarchy.BOT_DEVELOPER_USER_ID, 'bot']);
    assert.equal(calls.includes('controls'), !closed);
  }
});

test('non-developer cannot use controls even with Administrator permissions', async () => {
  const api = load({ getTicketData: () => ({ typeKey: 'dev_test' }),
    ignoreStaleTicketControlOutsideTicket: async () => { throw Error('must block before dispatch'); } },
    [section('async function handleTicketInteraction(', 'module.exports =')]);
  let reply;
  await api.handleTicketInteraction({ customId: 'ticket_assist', user: { id: 'administrator' }, channel: {},
    reply: async data => { reply = data; } });
  assert.match(reply.content, /only available to the bot developer/);
});

test('staff permission self-healing never grants non-developers dev test access', async () => {
  const api = load({ getTicketData: () => ({ typeKey: 'dev_test' }) },
    [section('async function setTicketStaffTyping(', 'async function ensureTicketSpeakerPermission(')]);
  assert.equal(await api.setTicketStaffTyping({}, 'other-staff', true, 'assist'), false);
  assert.match(source, /if \(!isReportStaff && typeKey !== 'dev_test'\)/);
});
