const { SlashCommandBuilder } = require('discord.js');
const { sendStaffTrackingPanel } = require('../staff-tracking');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('staff-stats')
    .setDescription('Open the staff performance and activity dashboard.'),

  async execute(interaction) {
    // Runtime access rules allow server Administrators plus the bot owner and
    // any staff explicitly whitelisted in Staff Tracking Settings.
    await sendStaffTrackingPanel(interaction);
  },
};
