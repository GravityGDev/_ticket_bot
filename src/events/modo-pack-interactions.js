const {
  Events,
  MessageFlags,
} = require('discord.js');

const {
  handleModoPackInteraction,
  isModoPackInteraction,
} = require('../modo-pack');

module.exports = {
  name:
    Events.InteractionCreate,

  async execute(
    interaction,
  ) {
    if (
      !isModoPackInteraction(
        interaction,
      )
    ) {
      return;
    }

    try {
      await handleModoPackInteraction(
        interaction,
      );
    } catch (error) {
      console.error(
        '[MODO PACK INTERACTION ERROR]',
        error,
      );

      const response = {
        content:
          'I could not update the Modo pack request.',
        flags:
          MessageFlags.Ephemeral,
      };

      if (
        interaction.replied ||
        interaction.deferred
      ) {
        await interaction
          .followUp(
            response,
          )
          .catch(
            () =>
              {},
          );
      } else if (
        interaction.isRepliable()
      ) {
        await interaction
          .reply(
            response,
          )
          .catch(
            () =>
              {},
          );
      }
    }
  },
};
