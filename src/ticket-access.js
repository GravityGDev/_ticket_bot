const { getMongoDb } = require('./database');

const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000;

function parseTicketMuteExpiry(value, now = new Date()) {
  const text = String(value || '').trim().toLowerCase();
  if (['permanent', 'permanently'].includes(text)) return null;
  if (!text) throw new Error('Enter permanent or a duration such as 20d, 24h, 1w, 1m or 1mon.');
  const pattern = /(\d+)\s*(mon|w|d|h|m|s)/g;
  let end = 0;
  let milliseconds = 0;
  let months = 0;
  for (const match of text.matchAll(pattern)) {
    if (text.slice(end, match.index).trim()) throw new Error('Invalid duration. Use 1w, 6d, 24h, 1m (minute), or 1mon (month).');
    end = match.index + match[0].length;
    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount)) throw new Error('Duration is too large.');
    if (match[2] === 'mon') months += amount;
    else milliseconds += amount * { w: 604800000, d: 86400000, h: 3600000, m: 60000, s: 1000 }[match[2]];
  }
  if (!end || text.slice(end).trim() || (!months && !milliseconds)) throw new Error('Enter a positive duration such as 20d, 24h, 1w, 1m or 1mon.');
  const expiry = new Date(now);
  const day = expiry.getUTCDate();
  expiry.setUTCDate(1);
  expiry.setUTCMonth(expiry.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth() + 1, 0)).getUTCDate();
  expiry.setUTCDate(Math.min(day, lastDay));
  expiry.setTime(expiry.getTime() + milliseconds);
  if (!Number.isFinite(expiry.getTime()) || expiry <= now) throw new Error('Duration is too large or invalid.');
  return expiry;
}

async function muteCollection() {
  return (await getMongoDb()).collection('ticket_creation_mutes');
}

async function setTicketMute(guildId, userId, expiresAt, actorId, reason) {
  await (await muteCollection()).updateOne(
    { _id: `${guildId}:${userId}` },
    { $set: { guildId: String(guildId), userId: String(userId), expiresAt, actorId: String(actorId), reason: String(reason || ''), updatedAt: new Date() } },
    { upsert: true },
  );
}

async function removeTicketMute(guildId, userId) {
  return (await muteCollection()).deleteOne({ _id: `${guildId}:${userId}` });
}

async function getTicketMute(guildId, userId, now = new Date()) {
  const record = await (await muteCollection()).findOne({ _id: `${guildId}:${userId}` });
  if (!record || (record.expiresAt && new Date(record.expiresAt) <= now)) return null;
  return record;
}

async function ticketCreationDenial(guild, member, now = Date.now()) {
  if (!member?.joinedTimestamp) return 'I could not verify when you joined this server. Please try again.';
  const mute = await getTicketMute(guild.id, member.id, new Date(now));
  if (mute) {
    return mute.expiresAt
      ? `You are muted from creating tickets until <t:${Math.floor(new Date(mute.expiresAt).getTime() / 1000)}:F> (<t:${Math.floor(new Date(mute.expiresAt).getTime() / 1000)}:R>).`
      : 'You are permanently muted from creating tickets. A member with access to /ticket-unmute must remove the mute.';
  }
  const eligibleAt = member.joinedTimestamp + FOUR_DAYS_MS;
  if (now < eligibleAt) return `You must be in the server for at least **4 days** before creating a ticket. You can create a ticket on <t:${Math.ceil(eligibleAt / 1000)}:F> (<t:${Math.ceil(eligibleAt / 1000)}:R>).`;
  return null;
}

module.exports = { FOUR_DAYS_MS, parseTicketMuteExpiry, setTicketMute, removeTicketMute, getTicketMute, ticketCreationDenial };
