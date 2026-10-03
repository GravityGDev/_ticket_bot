const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const discord = require('discord.js');

function load(file, overrides = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module, Buffer, process: { env: { TRANSCRIPT_SIGNING_SECRET: 'test-secret-for-transcript-integrity-only-12345' } },
    require: name => overrides[name] || require(name),
    console: { log() {}, warn() {}, error() {} },
    clearTimeout,
    setTimeout: overrides.__setTimeout || (callback => { callback(); return 0; }),
  });
  return module.exports;
}

const observedAt = Date.now();
function auditChannel(entries, { fail = null } = {}) {
  let fetches = 0;
  return {
    id: '789',
    client: { user: { id: '999' }, users: { fetch: async id => ({ id, username: 'Harry' }) } },
    guild: { fetchAuditLogs: async () => {
      if (fail) throw fail;
      const result = typeof entries === 'function' ? entries(fetches++) : entries;
      return { entries: new Map(result.map(entry => [entry.id, entry])) };
    } },
  };
}
function entry(overrides = {}) {
  return { id: 'audit', target: { id: '789' }, executor: { id: '456', username: 'Harry' }, createdTimestamp: observedAt, ...overrides };
}
const audit = load('src/ticket-deletion-audit.js');

test('manual deletion identifies the human audit executor', async () => {
  const actor = await audit.resolveTicketDeleter(auditChannel([entry()]), observedAt);
  assert.equal(actor.id, '456');
  assert.equal(actor.method, 'Manual channel deletion');
  assert.match(actor.label, /Harry.*456/);
});

test('Delete button attributes the requester rather than the bot executor', async () => {
  const actor = await audit.resolveTicketDeleter(auditChannel([entry({ executor: { id: '999' }, reason: audit.ticketDeleteReason('button', '456') })]), observedAt);
  assert.equal(actor.id, '456');
  assert.equal(actor.executorId, '999');
  assert.equal(actor.method, 'Delete button');
});

test('only this bot can assert a button requester in an audit reason', async () => {
  const actor = await audit.resolveTicketDeleter(auditChannel([entry({ reason: audit.ticketDeleteReason('button', '123') })]), observedAt);
  assert.equal(actor.id, '456');
  assert.equal(actor.method, 'Manual channel deletion');
});

test('audit resolution retries delayed entries and rejects stale or unrelated entries', async () => {
  const channel = auditChannel(attempt => attempt ? [entry()] : [entry({ target: { id: 'unrelated' } }), entry({ id: 'old', createdTimestamp: observedAt - 60000 })]);
  assert.equal((await audit.resolveTicketDeleter(channel, observedAt)).id, '456');
  const missing = await audit.resolveTicketDeleter(auditChannel([entry({ target: { id: 'other' } })]), observedAt);
  assert.equal(missing.id, null);
});

test('missing View Audit Log reports Unknown rather than a guessed user', async () => {
  const actor = await audit.resolveTicketDeleter(auditChannel([], { fail: { code: 50013 } }), observedAt);
  assert.equal(actor.id, null);
  assert.match(actor.label, /could not read audit logs/);
});

function fixture({ type = 'general_inquiry', uploadFails = false } = {}) {
  const docs = new Map(['bot_settings', 'report_staff_archives', 'report_staff_messages'].map(name => [name, new Map()]));
  const requests = [];
  const db = { collection(name) {
    const collection = docs.get(name);
    return {
      async findOne(query) { return collection?.get(query._id) || null; },
      async insertOne(value) {
        assert.ok(collection, 'must use existing collections at Atlas collection limit');
        collection.set(value._id, value);
      },
      async updateOne(query, update, options = {}) {
        assert.ok(collection, 'must use existing collections at Atlas collection limit');
        const insertPaths = Object.keys(update.$setOnInsert || {});
        for (const field of Object.keys(update.$push || {})) {
          assert.ok(!insertPaths.includes(field), 'MongoDB rejects conflicting $push / $setOnInsert paths');
        }
        const existing = collection.get(query._id);
        if (!existing && !options.upsert) return {};
        const record = existing || { _id: query._id, ...update.$setOnInsert };
        Object.assign(record, update.$set);
        for (const [key, amount] of Object.entries(update.$inc || {})) record[key] = (record[key] || 0) + amount;
        for (const [key, value] of Object.entries(update.$push || {})) (record[key] ||= []).push(value);
        collection.set(query._id, record);
        return {};
      },
      find(query) {
        const values = [...(collection?.values() || [])].filter(record => record.channelId === query.channelId);
        return { sort: () => ({ toArray: async () => values.sort((a, b) => a.createdTimestamp - b.createdTimestamp) }) };
      },
    };
  } };
  const database = { getMongoDb: async () => db };
  const integrity = load('src/transcript-integrity.js', { './database': database });
  const send = async response => {
    if (uploadFails) throw Error('Discord upload unavailable');
    requests.push(response);
    return { id: String(requests.length), attachments: { first: () => ({ url: 'https://cdn.discordapp.com/transcript.html' }) }, edit: async () => {}, components: [] };
  };
  const deletedBy = { id: '456', label: 'Harry (456)', method: 'Delete button', executorId: '999', deletedAt: new Date(observedAt).toISOString(), auditEntryId: 'audit' };
  const tracker = load('src/report-staff-tracker.js', {
    './database': database,
    './ticket-store': { getTicketState: async () => ({ number: 464, creatorId: '123', typeKey: type, closedById: '456', closedAt: new Date(observedAt).toISOString(), claimHistory: [{ userId: '456', action: 'claim' }] }) },
    './ticket-deletion-audit': { resolveTicketDeleter: async () => deletedBy },
    './transcript-integrity': integrity,
  });
  const channel = {
    id: '789', name: 'renamed-ticket', topic: `Ticket #464 | Type=${type} | Created by <@123>`,
    guild: { id: 'guild', channels: { cache: new Map([['1538580589542777055', { isTextBased: () => true, send }]]) } },
    client: { user: { id: '999' }, users: { fetch: async id => ({ id, send }) } },
    messages: { fetch: async () => new Map() },
  };
  function message(id, content) {
    return {
      id, channel, channelId: channel.id, guild: channel.guild, guildId: channel.guild.id,
      author: { id: '123', username: 'owner', bot: false },
      member: { displayName: 'Owner', displayHexColor: '#ff0000' },
      content, createdTimestamp: observedAt - 2000, attachments: new Map(), stickers: new Map(), embeds: [],
    };
  }
  return { tracker, integrity, docs, requests, channel, message, deletedBy };
}

test('normal manual/channel deletion recovers signed history, replies and the deletion audit', async () => {
  const f = fixture();
  await f.tracker.trackReportStaffMessageCreate(f.message('1', 'original <script>alert(1)</script>'));
  const reply = f.message('2', 'reply');
  reply.reference = { messageId: '1' };
  await f.tracker.trackReportStaffMessageCreate(reply);
  await f.tracker.handleReportStaffChannelDelete(f.channel);
  assert.equal(f.requests.length, 1);
  const html = f.requests[0].files[0].attachment.toString();
  assert.match(html, /Harry \(456\)/);
  assert.match(html, /Delete button/);
  assert.match(html, /Reply to Owner/);
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /#ff0000/);
  assert.equal((await f.integrity.verifyTranscriptHtml(html)).valid, true);
  const record = [...f.docs.get('bot_settings').values()][0];
  assert.equal(record.metadata.deletedById, '456');
  assert.equal(record.metadata.deletionMethod, 'Delete button');
  assert.equal(f.docs.get('report_staff_archives').get('789').deletedById, '456');
  // Redelivery of the same channelDelete event must not send another final transcript.
  await f.tracker.handleReportStaffChannelDelete(f.channel);
  assert.equal(f.requests.length, 1);
});

test('edited and deleted messages survive without conflicting MongoDB revision updates', async () => {
  const f = fixture();
  const old = f.message('1', 'first');
  await f.tracker.trackReportStaffMessageCreate(old);
  await f.tracker.trackReportStaffMessageUpdate(old, f.message('1', 'second'));
  await f.tracker.trackReportStaffMessageDelete(old);
  await f.tracker.handleReportStaffChannelDelete(f.channel);
  const html = f.requests[0].files[0].attachment.toString();
  assert.match(html, /first/);
  assert.match(html, /second/);
  assert.match(html, /DELETED AFTER LOGGING/);
});

test('report staff deletion retains security and creator DM backups with signed deletion details', async () => {
  const f = fixture({ type: 'report_staff' });
  await f.tracker.trackReportStaffMessageCreate(f.message('1', 'report evidence'));
  await f.tracker.handleReportStaffChannelDelete(f.channel);
  assert.equal(f.requests.length, 2);
  for (const request of f.requests) {
    const html = request.files[0].attachment.toString();
    assert.equal((await f.integrity.verifyTranscriptHtml(html)).valid, true);
    assert.match(html, /Harry \(456\)/);
    assert.match(html, /Delete button/);
  }
});

test('upload failure preserves messages and deletion actor in MongoDB', async () => {
  const f = fixture({ uploadFails: true });
  await f.tracker.trackReportStaffMessageCreate(f.message('1', 'retained'));
  await assert.rejects(f.tracker.handleReportStaffChannelDelete(f.channel), /upload unavailable/);
  const meta = f.docs.get('report_staff_archives').get('789');
  assert.equal(meta.deletedById, '456');
  assert.match(meta.deleteTranscriptSendError, /upload unavailable/);
  assert.equal(f.docs.get('report_staff_messages').size, 1);
});

test('ordinary channels and fake Type-only topics are not archived', async () => {
  const f = fixture();
  f.channel.topic = 'Type=report_staff';
  await f.tracker.trackReportStaffMessageCreate(f.message('1', 'ordinary chat'));
  await f.tracker.handleReportStaffChannelDelete(f.channel);
  assert.equal(f.docs.get('report_staff_messages').size, 0);
  assert.equal(f.requests.length, 0);
});

test('old integrity records still verify after moving new signatures to shared settings', async () => {
  const f = fixture();
  await f.tracker.trackReportStaffMessageCreate(f.message('1', 'legacy verification'));
  await f.tracker.handleReportStaffChannelDelete(f.channel);
  const html = f.requests[0].files[0].attachment.toString();
  const current = [...f.docs.get('bot_settings').values()][0];
  f.docs.get('bot_settings').clear();
  f.docs.set('transcript_integrity', new Map([[current.transcriptId, { ...current, _id: current.transcriptId }]]));
  assert.equal((await f.integrity.verifyTranscriptHtml(html)).valid, true);
  assert.equal((await f.integrity.verifyTranscriptHtml(html.replace('legacy verification', 'changed text'))).valid, false);
});


test('confirmed button deletion works without View Audit Log and never credits failed deletes', async () => {
  const api = load('src/ticket-deletion-audit.js', { __setTimeout: setTimeout });
  const channel = auditChannel([], { fail: { code: 50013 } });
  channel.delete = async reason => { assert.equal(reason, 'SNAY_TICKET_DELETE:button:456'); };
  await api.deleteTicketChannel(channel, 'button', { id: '456', username: 'Harry' });
  const actor = await api.resolveTicketDeleter(channel);
  assert.equal(actor.id, '456');
  assert.equal(actor.method, 'Delete button');
  channel.id = 'failed';
  channel.delete = async () => { throw Error('Missing Manage Channels'); };
  await assert.rejects(api.deleteTicketChannel(channel, 'button', { id: '456' }), /Manage Channels/);
  assert.equal((await api.resolveTicketDeleter(channel)).id, null);
});

test('channelDelete arriving before the HTTP response waits for confirmed button attribution', async () => {
  const api = load('src/ticket-deletion-audit.js', { __setTimeout: setTimeout });
  const channel = auditChannel([], { fail: { code: 50013 } });
  let confirm;
  channel.delete = () => new Promise(resolve => { confirm = resolve; });
  const request = api.deleteTicketChannel(channel, 'button', { id: '456', username: 'Harry' });
  const lookup = api.resolveTicketDeleter(channel);
  confirm();
  await request;
  assert.equal((await lookup).id, '456');
});

test('automatic cleanup is labeled as automation with its bot actor', async () => {
  const actor = await audit.resolveTicketDeleter(auditChannel([entry({ executor: { id: '999', username: 'Bot' }, reason: audit.ticketDeleteReason('automatic', '999') })]), observedAt);
  assert.equal(actor.id, '999');
  assert.equal(actor.method, 'Automatic (creator left server)');
});
