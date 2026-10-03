const { Events } = require('discord.js');
const { closeDepartedCreatorTickets } = require('../ticket-system');

module.exports = {
  name: Events.GuildMemberRemove,
  async execute(member) {
    await closeDepartedCreatorTickets(member.guild, member.id).catch(error => {
      console.error('[TICKET CREATOR DEPARTURE ERROR]', error);
    });
  },
};
