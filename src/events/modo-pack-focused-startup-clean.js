const {
  Events,
} = require('discord.js');

const {
  cleanExistingFocusedChannel,
} = require('./modo-pack-live-cleaner');

module.exports = {
  name:
    Events.ClientReady,

  once:
    true,

  async execute(
    client,
  ) {
    await cleanExistingFocusedChannel(
      client,
    ).catch(
      (error) => {
        console.error(
          '[MODO PACK FOCUSED STARTUP CLEAN ERROR]',
          error,
        );
      },
    );
  },
};
