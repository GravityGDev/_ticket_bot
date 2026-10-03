const { Events } = require('discord.js');
const { closeDepartedCreatorTickets } = require('../ticket-system');

module.exports = {
  name: Events.ClientReady,
  once: true,
  async execute(client) {
    let running = false;
    const reconcile = async () => {
      if (running) return;
      running = true;
      try {
        for (const guild of client.guilds.cache.values()) {
          await closeDepartedCreatorTickets(guild).catch(error => {
            console.error('[TICKET DEPARTURE RECONCILE ERROR]', error);
          });
        }
      } finally {
        running = false;
      }
    };
    await reconcile();
    const timer = setInterval(reconcile, 15 * 60 * 1000);
    timer.unref();
  },
};
