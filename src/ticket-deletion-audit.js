const { AuditLogEvent } = require('discord.js');
const directDeletions = new Map();

function ticketDeleteReason(method, userId) {
  return `SNAY_TICKET_DELETE:${method}:${userId}`;
}

async function deleteTicketChannel(channel, method, user) {
  const key = String(channel.id);
  let finish;
  const result = new Promise(resolve => { finish = resolve; });
  directDeletions.set(key, result);
  try {
    const deleted = await channel.delete(ticketDeleteReason(method, user.id));
    finish({
      id: user.id, label: `${user.username || user.tag || 'User'} (${user.id})`,
      method: method === 'button' ? 'Delete button' : 'Automatic (creator left server)',
      executorId: channel.client.user.id, deletedAt: new Date().toISOString(), auditEntryId: null,
    });
    // ChannelDelete may arrive just before or after the HTTP response.
    const cleanup = setTimeout(() => { if (directDeletions.get(key) === result) directDeletions.delete(key); }, 60000);
    cleanup?.unref?.();
    return deleted;
  } catch (error) {
    finish(null);
    if (directDeletions.get(key) === result) directDeletions.delete(key);
    throw error;
  }
}

async function resolveTicketDeleter(channel, observedAt = Date.now()) {
  const direct = directDeletions.get(String(channel.id));
  if (direct) {
    let timer;
    const confirmed = await Promise.race([
      direct,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); }),
    ]);
    if (timer) clearTimeout(timer);
    if (confirmed) return confirmed;
  }
  let auditError;
  // ChannelDelete can arrive before its audit entry. Only match this channel
  // and a nearby timestamp; never attribute a different channel's deletion.
  for (const pause of [0, 800, 1600]) {
    if (pause) await new Promise(resolve => setTimeout(resolve, pause));
    try {
      const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 30 });
      const entry = [...logs.entries.values()].find(candidate =>
        String(candidate.target?.id || candidate.targetId) === String(channel.id) &&
        Number(candidate.createdTimestamp) >= observedAt - 15000 &&
        Number(candidate.createdTimestamp) <= Date.now() + 1000,
      );
      if (!entry?.executor?.id) continue;
      const executor = entry.executor;
      const requested = String(entry.reason || '').match(/^SNAY_TICKET_DELETE:(button|automatic):(\d+)$/);
      const byThisBot = String(executor.id) === String(channel.client.user.id);
      let actor = executor;
      let method = byThisBot ? 'Bot / automation' : 'Manual channel deletion';
      if (byThisBot && requested) {
        method = requested[1] === 'button' ? 'Delete button' : 'Automatic (creator left server)';
        actor = await channel.client.users.fetch(requested[2]).catch(() => null) || { id: requested[2] };
      }
      return {
        id: actor.id,
        label: `${actor.username || actor.tag || 'User'} (${actor.id})`,
        method, executorId: executor.id,
        deletedAt: new Date(entry.createdTimestamp).toISOString(),
        auditEntryId: entry.id,
      };
    } catch (error) {
      auditError = error;
      if (Number(error.code) === 50013 || Number(error.code) === 50001) break;
    }
  }
  if (auditError) console.error('[TICKET DELETE AUDIT LOG ERROR]', auditError);
  return {
    id: null, label: auditError ? 'Unknown (bot could not read audit logs)' : 'Unknown (audit entry unavailable)',
    method: 'Unknown', executorId: null, deletedAt: new Date(observedAt).toISOString(), auditEntryId: null,
  };
}

module.exports = { ticketDeleteReason, deleteTicketChannel, resolveTicketDeleter };
