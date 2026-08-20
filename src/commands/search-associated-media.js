const {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
} = require('discord.js');
const {
  executeSkinContextSearch,
} = require('../skin-review');

module.exports = {
  data:
    new ContextMenuCommandBuilder()
      .setName(
        'Search Associated Media',
      )
      .setType(
        ApplicationCommandType.Message,
      ),

  async execute(
    interaction,
    client,
  ) {
    await executeSkinContextSearch(
      interaction,
      client,
    );
  },
};
