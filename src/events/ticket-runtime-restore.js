const {
  Events,
} = require('discord.js');

const {
  restoreTicketRuntimeState,
} = require('../ticket-system');

module.exports = {
  name:
    Events.ClientReady,
  once:
    true,

  async execute(
    readyClient,
  ) {
    try {
      await restoreTicketRuntimeState(
        readyClient,
      );
    } catch (error) {
      console.error(
        '[TICKET REBOOT RESTORE STARTUP ERROR]',
        error,
      );
    }
  },
};
