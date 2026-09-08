const STAFF_ROLE_IDS = Object.freeze([
  // Lowest -> highest.
  '1334635057180315752',
  '1288541260394659921',
  '950143139115585536',
  '954409212581138512',
  '1258406734838497290',
  '1505615310986940446',
  '1035663004152369172',
  '950141448307740672',
  '952042367026880583',
  '1546841314350473297',
  '1546436573724283020',
]);

// Bot developer / owner bypass. This account can never lock itself out of the
// permissions editor.
const BOT_DEVELOPER_USER_ID = '1150135578378125383';

function getHighestStaffRoleIndex(member) {
  if (!member?.roles?.cache) return -1;

  for (
    let index = STAFF_ROLE_IDS.length - 1;
    index >= 0;
    index -= 1
  ) {
    if (
      member.roles.cache.has(
        STAFF_ROLE_IDS[index],
      )
    ) {
      return index;
    }
  }

  return -1;
}

function getHighestStaffRoleId(member) {
  const index =
    getHighestStaffRoleIndex(
      member,
    );

  return index >= 0
    ? STAFF_ROLE_IDS[index]
    : null;
}

function isStaffMember(member) {
  return (
    getHighestStaffRoleIndex(
      member,
    ) >= 0
  );
}

function isBotDeveloper(userOrMember) {
  const id =
    userOrMember?.id ||
    userOrMember?.user?.id ||
    null;

  return (
    String(id || '') ===
    BOT_DEVELOPER_USER_ID
  );
}

function roleLevelNumber(index) {
  return Number(index) + 1;
}

module.exports = {
  STAFF_ROLE_IDS,
  BOT_DEVELOPER_USER_ID,
  getHighestStaffRoleIndex,
  getHighestStaffRoleId,
  isStaffMember,
  isBotDeveloper,
  roleLevelNumber,
};
