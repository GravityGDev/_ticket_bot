const { Events, ActivityType } = require('discord.js');

module.exports = {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`Serving ${client.guilds.cache.size} server(s).`);

    client.user.setActivity('/ping', {
      type: ActivityType.Watching,
    });
  },
};
