const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { ChannelType } = require('discord.js');

function fixture() {
  const collections = new Map([['bot_settings', new Map()], ['server_configs', new Map()]]);
  const writes = [];
  const module = { exports: {} };
  const db = { collection: name => ({
    findOne: async ({ _id }) => collections.get(name)?.get(_id) || null,
    updateOne: async ({ _id }, { $set }) => {
      assert.ok(collections.has(name), 'cannot create a collection at Atlas limit');
      writes.push(name);
      collections.get(name).set(_id, { _id, ...$set });
    },
    deleteOne: async ({ _id }) => collections.get(name)?.delete(_id),
  }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/config-store.js'), 'utf8'), {
    module, require: () => ({ MONGODB_DB_NAME: 'test', getMongoDb: async () => db }),
  });
  return { api: module.exports, collections, writes };
}

test('legacy setup is preserved, new saves use existing bot settings and take precedence', async () => {
  const f = fixture();
  f.collections.get('server_configs').set('1', { categoryId: '123', roleIds: ['456'] });
  assert.equal((await f.api.getServerConfig('1')).roleIds[0], '456');
  await f.api.setServerConfig('1', { categoryId: '789', roleIds: ['456', '456', 'bad'] });
  const config = await f.api.getServerConfig('1');
  assert.equal(config.categoryId, '789');
  assert.deepEqual([...config.roleIds], ['456']);
  assert.deepEqual(f.writes, ['bot_settings']);
  assert.equal(await f.api.getServerConfig('2'), null);
  await f.api.deleteServerConfig('1');
  assert.equal(await f.api.getServerConfig('1'), null);
});

test('missing legacy collection never needs creating, guild settings stay isolated', async () => {
  const f = fixture();
  f.collections.delete('server_configs');
  await f.api.setServerConfig('1', { categoryId: '123', roleIds: [] });
  assert.equal((await f.api.getServerConfig('1')).categoryId, '123');
  assert.equal(await f.api.getServerConfig('2'), null);
});

function guildConfigApi(getServerConfig, categoryId) {
  const source = fs.readFileSync(path.join(__dirname, '../src/ticket-system.js'), 'utf8');
  const context = { getServerConfig, ChannelType, process: { env: { TICKET_CATEGORY_ID: categoryId } } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function getGuildConfig('), source.indexOf('\nfunction hasSetupPermission')) + '\nthis.load = getGuildConfig;', context);
  return context.load;
}
const guild = { id: '1', channels: { cache: new Map(), fetch: async id => id === '123' ? { id, type: ChannelType.GuildCategory } : null } };

test('missing setup recovers only the explicitly configured valid category, without granting roles', async () => {
  const load = guildConfigApi(async () => null, '123');
  const config = await load(guild);
  assert.equal(config.categoryId, '123');
  assert.equal(config.roleIds.length, 0);
  for (const id of [undefined, '', 'invalid', '999']) assert.equal(await guildConfigApi(async () => null, id)(guild), null);
});

test('database errors propagate and cannot masquerade as missing setup or use fallback', async () => {
  const load = guildConfigApi(async () => { throw Error('MongoDB offline'); }, '123');
  await assert.rejects(load(guild), /MongoDB offline/);
});

test('saved category and roles take precedence over deployment fallback', async () => {
  const saved = { categoryId: '777', roleIds: ['456'] };
  assert.equal(await guildConfigApi(async () => saved, '123')(guild), saved);
});
