// Full member fetches use Discord's gateway. Share them across every feature;
// individual member lookups can continue to use the REST API as usual.
function createGuildMemberLoader({
  now = Date.now,
  logger = console,
  refreshMs = 5 * 60 * 1000,
  failureCooldownMs = 60 * 1000,
} = {}) {
  const states = new WeakMap();

  return async function ensureGuildMembers(guild) {
    let state = states.get(guild);
    if (!state) {
      state = { pending: null, nextFetchAt: 0 };
      states.set(guild, state);
    }
    if (state.pending) return state.pending;
    if (now() < state.nextFetchAt) return guild.members.cache;

    // Schedule the fetch after storing the promise so simultaneous rank, team,
    // panel and goal requests cannot each start their own gateway request.
    state.pending = Promise.resolve().then(async () => {
      try {
        await guild.members.fetch({ time: 15000 });
        state.nextFetchAt = now() + refreshMs;
      } catch (error) {
        const retrySeconds = Number(error?.data?.retry_after);
        const cooldown = Math.max(
          failureCooldownMs,
          Number.isFinite(retrySeconds) && retrySeconds > 0
            ? retrySeconds * 1000 + 250
            : 0,
        );
        state.nextFetchAt = now() + cooldown;
        logger.warn(
          `[MEMBER CACHE] Guild ${guild.id}: using cached members; ` +
          `full refresh paused for ${Math.ceil(cooldown / 1000)}s ` +
          `(${error?.name || 'Error'}: ${error?.message || 'fetch failed'}).`,
        );
      }
      // Return the live SDK cache. Join/leave/role events keep it current
      // between full refreshes; do not hold a separate stale member snapshot.
      return guild.members.cache;
    }).finally(() => { state.pending = null; });
    return state.pending;
  };
}

const ensureGuildMembers = createGuildMemberLoader();
module.exports = { ensureGuildMembers, createGuildMemberLoader };
