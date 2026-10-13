// Loads every member of a guild into the cache so leave, boost and member-update
// events fire with full data after a restart. Never throws.
export async function fetchGuildMembers(guild) {
  try {
    await guild.members.fetch();
    return true;
  } catch (err) {
    console.warn(`Could not fetch members of guild ${guild.id}: ${err.message}`);
    return false;
  }
}
