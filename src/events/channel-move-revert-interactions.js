const {
  Events,
} = require('discord.js');

const {
  handleChannelMoveRevertInteraction,
} = require('./channel-move-logger');

module.exports = {
  name:
    Events.InteractionCreate,

  async execute(
    interaction,
  ) {
    await handleChannelMoveRevertInteraction(
      interaction,
    );
  },
};
