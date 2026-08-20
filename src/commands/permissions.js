const {
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const {
  sendPermissionPanel,
} = require('../staff-command-permissions');

module.exports = {
  data:
    new SlashCommandBuilder()
      .setName('permissions')
      .setDescription(
        'Configure minimum staff-role access for bot commands.',
      )
      // This is only a Discord UI hint. Runtime access is developer-only.
      .setDefaultMemberPermissions(
        PermissionFlagsBits.Administrator,
      ),

  async execute(
    interaction,
    client,
  ) {
    await sendPermissionPanel(
      interaction,
      client,
    );
  },
};
