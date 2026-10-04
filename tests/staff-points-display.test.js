const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const discord = require('discord.js');
const sharp = require('sharp');
const pointsApi = require('../src/staff-activity-points');

function trackingApi() {
  const context = {
    module: { exports: {} }, console,
    require: name => name === 'discord.js' ? discord : name === './staff-activity-points' ? pointsApi : {},
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/staff-tracking.js'), 'utf8') + '\nthis.api = { withActivityPoints, sortLeaderboard, buildLeaderboardEmbed };', context);
  return context.api;
}

async function rankFixture(override) {
  const member = { id: '123', displayName: 'Test Staff', roles: { cache: new Map() }, user: { username: 'staff', bot: false, displayAvatarURL: () => 'unused' } };
  const guild = { id: 'guild', name: 'Test', members: { cache: new Map([[member.id, member]]), fetch: async () => {} } };
  const snapshot = { claimCounts: new Map([[member.id, 3]]), messageCounts: new Map([[member.id, 4]]) };
  const settings = { ticketClaimPoints: 0.5, trackedMessagePoints: 1, hiddenStaffUserIds: [] };
  const module = { exports: {} };
  const captureSharp = buffer => {
    if (buffer.toString().includes('<svg width="1536"')) {
      return { png: () => ({ toBuffer: async () => buffer }) };
    }
    return sharp(buffer);
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/staff-rank.js'), 'utf8'), {
    module, Buffer, console: { log() {}, error() {} }, fetch: async () => { throw Error('use local avatar fallback'); },
    require: name => {
      if (name === 'sharp') return captureSharp;
      if (name === 'discord.js') return discord;
      if (name === './rank-font-runtime') return { configureRankFonts() {} };
      if (name === './staff-activity-points') return pointsApi;
      if (name === './staff-tracking-store') return { getStaffSnapshot: async () => snapshot };
      if (name === './staff-settings-store') return { getStaffTrackingSettings: async () => settings };
      if (name === './staff-point-overrides-store') return { getStaffPointOverridesForPeriod: async () => new Map(override ? [[member.id, override]] : []) };
      if (name === './staff-role-hierarchy') return { isStaffMember: () => true };
      throw Error(name);
    },
  });
  const svg = (await module.exports.renderRankCard(guild, member, 'lifetime')).toString();
  return { svg, snapshot };
}

const settings = { ticketClaimPoints: 0.5, trackedMessagePoints: 1 };

test('ticket/message manual totals are independent and agree with total score', () => {
  const value = pointsApi.calculateStaffActivityPoints(3, 4, settings, { ticketPoints: 100.5, messagePoints: 12.5 });
  assert.equal(value.ticketPoints, 100.5);
  assert.equal(value.messagePoints, 12.5);
  assert.equal(value.activityScore, 113);
  assert.equal(value.ticketPointsManual, true);
  assert.equal(value.messagePointsManual, true);
  const automatic = pointsApi.calculateStaffActivityPoints(3, 4, settings, { ticketPoints: null, messagePoints: null });
  assert.equal(automatic.ticketPoints, 1.5);
  assert.equal(automatic.messagePoints, 4);
  assert.equal(automatic.ticketPointsManual, false);
});

test('manual totals keep gaining automatic ticket and message points after the edit', () => {
  const override = {
    ticketPoints: 100.5,
    messagePoints: 12.5,
    ticketPointsBaselines: { lifetime: 1.5 },
    messagePointsBaselines: { lifetime: 4 },
  };

  const unchanged = pointsApi.calculateStaffActivityPoints(
    3,
    4,
    settings,
    override,
    'lifetime',
  );
  assert.equal(unchanged.ticketPoints, 100.5);
  assert.equal(unchanged.messagePoints, 12.5);

  const grown = pointsApi.calculateStaffActivityPoints(
    5,
    7,
    settings,
    override,
    'lifetime',
  );
  assert.equal(grown.ticketPoints, 101.5);
  assert.equal(grown.messagePoints, 15.5);
  assert.equal(grown.activityScore, 117);
  assert.equal(grown.ticketPointsAdjustment, 99);
  assert.equal(grown.messagePointsAdjustment, 8.5);
});

test('rank card renders manual categories and values rather than raw counts', async () => {
  const { svg, snapshot } = await rankFixture({ ticketPoints: 100.5, messagePoints: 12.5 });
  assert.match(svg, />TICKET<\/text>/);
  assert.match(svg, />MESSAGE<\/text>/);
  assert.match(svg, />POINTS<\/text>/);
  assert.match(svg, />100.5<\/text>/);
  assert.match(svg, />12.5<\/text>/);
  assert.match(svg, />113<\/text>/);
  assert.match(svg, /Manual totals/);
  assert.equal(snapshot.claimCounts.get('123'), 3);
  assert.equal(snapshot.messageCounts.get('123'), 4);
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  assert.equal((await sharp(png).metadata()).width, 1536);
  if (process.env.POINT_DISPLAY_QA_PATH) fs.writeFileSync(process.env.POINT_DISPLAY_QA_PATH, png);
});

test('zero manual points and one-category overrides display correctly; AUTO restores counts', async () => {
  const zero = await rankFixture({ ticketPoints: 0, messagePoints: null });
  assert.match(zero.svg, />TICKET<\/text>/);
  assert.match(zero.svg, />TRACKED<\/text>/);
  const message = await rankFixture({ ticketPoints: null, messagePoints: 20 });
  assert.match(message.svg, />TICKETS<\/text>/);
  assert.match(message.svg, />MESSAGE<\/text>/);
  assert.match(message.svg, />20<\/text>/);
  const auto = await rankFixture(null);
  assert.match(auto.svg, />CLAIMED<\/text>/);
  assert.match(auto.svg, />MESSAGES<\/text>/);
  assert.ok(!auto.svg.includes('Manual totals'));
});

test('leaderboard includes manual-only staff and shows matching point breakdowns', () => {
  const api = trackingApi();
  const row = api.withActivityPoints({ member: { id: '123', displayName: 'Staff' }, claims: 0, messages: 0, active: false }, settings, { ticketPoints: 50.5, messagePoints: 0 });
  assert.equal(row.active, true);
  const embed = api.buildLeaderboardEmbed({
    guild: { channels: { cache: new Map() } }, periodKey: 'weekly', filterKey: 'all',
    allRows: [row], filteredRows: [row], pageInfo: { rows: [row], start: 0, page: 0, pageCount: 1 },
    trackingRules: { trackedCategoryIds: [] }, pointSettings: settings,
  }).toJSON();
  const text = embed.fields.map(field => field.value).join('\n');
  assert.match(text, /50.5 ticket pts/);
  assert.match(text, /0 message pts/);
  assert.match(text, /50.5 pts/);
});

test('large leaderboard totals preserve all ten complete rows within Discord field limits', () => {
  const api = trackingApi();
  const rows = Array.from({ length: 10 }, (_, index) => api.withActivityPoints({
    member: { id: `123456789012345678${index}`, displayName: String(index) }, claims: 0, messages: 0,
    hasStar: true, starLevel: 2, hasWarning: true,
  }, settings, { ticketPoints: 10000000, messagePoints: 10000000 }));
  const fields = api.buildLeaderboardEmbed({
    guild: { channels: { cache: new Map() } }, periodKey: 'weekly', filterKey: 'all',
    allRows: rows, filteredRows: rows, pageInfo: { rows, start: 0, page: 0, pageCount: 1 },
    trackingRules: { trackedCategoryIds: [] }, pointSettings: settings,
  }).toJSON().fields.filter(field => field.name.includes('Leaderboard'));
  assert.ok(fields.length > 1);
  assert.ok(fields.every(field => field.value.length <= 1024));
  const lines = fields.flatMap(field => field.value.split('\n'));
  assert.equal(lines.length, 10);
  assert.ok(lines.every(line => line.endsWith('10,000,000 message pts')));
});
