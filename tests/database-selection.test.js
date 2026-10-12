const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const selection = require('../src/database-selection');

const logger = () => {
  const lines = [];
  return { lines, log: text => lines.push(text), warn: text => lines.push(text) };
};

test('explicit database wins; otherwise the original database in URI is respected', () => {
  assert.equal(selection.configuredDatabaseName('mongodb://host/Original', ' Explicit '), 'Explicit');
  assert.equal(selection.configuredDatabaseName('mongodb+srv://host/Snay_ticket_bot?retryWrites=true'), 'Snay_ticket_bot');
  assert.equal(selection.configuredDatabaseName('mongodb://a:27017,b:27017/StaffHistory'), 'StaffHistory');
  assert.equal(selection.configuredDatabaseName('mongodb://host/Staff%5FHistory'), 'Staff_History');
  assert.equal(selection.configuredDatabaseName('mongodb://host/test'), 'test');
});

test('URIs without a database keep the old bot default, not driver test or authSource', () => {
  for (const uri of [undefined, 'mongodb://host', 'mongodb://host/', 'mongodb+srv://host/?authSource=admin']) {
    assert.equal(selection.configuredDatabaseName(uri, ' '), 'snay_ticket_bot');
  }
});

test('case recovery selects only the existing spelling and makes no writes', async () => {
  const log = logger();
  let calls = 0;
  const client = { db: name => ({ command: async command => {
    calls++;
    assert.equal(name, 'admin');
    assert.equal(command.authorizedDatabases, true);
    assert.equal(command.nameOnly, true);
    assert.equal(command.filter.name.$regex, '^snay_ticket_bot$');
    return { databases: [{ name: 'Snay_ticket_bot' }, { name: 'unrelated' }] };
  } }) };
  assert.equal(await selection.canonicalDatabaseName(client, 'snay_ticket_bot', log), 'Snay_ticket_bot');
  assert.equal(calls, 1);
  assert.match(log.lines[0], /existing database spelling/);
});

test('missing, ambiguous or inaccessible names never switch to another database', async () => {
  for (const databases of [[], [{ name: 'AnotherBot' }], [{ name: 'db' }, { name: 'DB' }]]) {
    const client = { db: () => ({ command: async () => ({ databases }) }) };
    assert.equal(await selection.canonicalDatabaseName(client, 'db', logger()), 'db');
  }
  const log = logger();
  const client = { db: () => ({ command: async () => { throw Object.assign(Error('secret URI must not be logged'), { codeName: 'Unauthorized' }); } }) };
  assert.equal(await selection.canonicalDatabaseName(client, 'db', log), 'db');
  assert.ok(!log.lines.join('\n').includes('secret'));
});

test('database names are escaped before requesting a case-insensitive name check', async () => {
  const client = { db: () => ({ command: async command => {
    assert.equal(command.filter.name.$regex, '^staff\\+history$');
    return { databases: [] };
  } }) };
  assert.equal(await selection.canonicalDatabaseName(client, 'staff+history', logger()), 'staff+history');
});

test('startup diagnostics expose guild counts and detect fresh data without writing', async () => {
  const log = logger();
  const db = { databaseName: 'History', collection: name => ({
    countDocuments: async filter => { assert.equal(filter.guildId, 'guild'); return name === 'staff_activity_messages' ? 1 : 0; },
    findOne: async filter => { assert.equal(filter._id, 'guild'); return null; },
  }) };
  await selection.logStaffDataHealth(db, 'guild', log);
  assert.match(log.lines[0], /claims=0 messages=1 overrides=0 savedSettings=false/);
  assert.match(log.lines[1], /original Atlas cluster/);
  const absent = logger();
  await selection.logStaffDataHealth(db, null, absent);
  assert.equal(absent.lines.length, 0);
});

test('every store uses the recovered database and concurrent callers share one connection', async () => {
  let connects = 0;
  const requested = [];
  const log = logger();
  class FakeClient {
    async connect() { connects++; return this; }
    db(name) {
      requested.push(name);
      return { databaseName: name, command: async command => command.ping ? { ok: 1 } : { databases: [{ name: 'Snay_ticket_bot' }] } };
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/database.js'), 'utf8'), {
    module, console: log, process: { env: { MONGODB_URI: 'mongodb://host/', MONGODB_DB_NAME: 'snay_ticket_bot' } },
    require: name => name === 'mongodb' ? { MongoClient: FakeClient, ServerApiVersion: { v1: '1' } } : selection,
  });
  const dbs = await Promise.all(Array.from({ length: 10 }, () => module.exports.getMongoDb()));
  assert.equal(connects, 1);
  assert.ok(dbs.every(db => db.databaseName === 'Snay_ticket_bot'));
  assert.equal(module.exports.MONGODB_DB_NAME, 'Snay_ticket_bot');
  assert.equal(requested.includes('snay_ticket_bot'), false);
});
