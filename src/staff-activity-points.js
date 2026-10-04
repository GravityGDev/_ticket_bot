const POINT_PERIODS = Object.freeze([
  'weekly',
  'monthly',
  'quarterly',
  'lifetime',
]);

function cleanPointPeriod(periodKey) {
  return POINT_PERIODS.includes(periodKey) ? periodKey : 'lifetime';
}

function getManualPointValue(calculatedPoints, override, valueField, baselineField, periodKey) {
  const manualValue = override?.[valueField];

  if (!Number.isFinite(manualValue)) {
    return {
      value: calculatedPoints,
      manual: false,
      baseline: null,
      adjustment: 0,
    };
  }

  const period = cleanPointPeriod(periodKey);
  const savedBaseline = override?.[baselineField]?.[period];

  // Legacy overrides did not store a baseline and therefore froze forever.
  // The store now migrates those records. Keeping this fallback makes old/test
  // data render safely until migration has completed.
  const baseline = Number.isFinite(savedBaseline)
    ? Number(savedBaseline)
    : calculatedPoints;

  const adjustment = Number(manualValue) - baseline;
  const value = Math.max(0, calculatedPoints + adjustment);

  return {
    value,
    manual: true,
    baseline,
    adjustment,
  };
}

function calculateStaffActivityPoints(
  tickets,
  messages,
  settings,
  override = null,
  periodKey = 'lifetime',
) {
  const calculatedTicketPoints = tickets * settings.ticketClaimPoints;
  const calculatedMessagePoints = messages * settings.trackedMessagePoints;

  const ticket = getManualPointValue(
    calculatedTicketPoints,
    override,
    'ticketPoints',
    'ticketPointsBaselines',
    periodKey,
  );

  const message = getManualPointValue(
    calculatedMessagePoints,
    override,
    'messagePoints',
    'messagePointsBaselines',
    periodKey,
  );

  return {
    calculatedTicketPoints,
    calculatedMessagePoints,
    ticketPoints: ticket.value,
    messagePoints: message.value,
    ticketPointsManual: ticket.manual,
    messagePointsManual: message.manual,
    ticketPointsBaseline: ticket.baseline,
    messagePointsBaseline: message.baseline,
    ticketPointsAdjustment: ticket.adjustment,
    messagePointsAdjustment: message.adjustment,
    activityScore: ticket.value + message.value,
  };
}

module.exports = {
  POINT_PERIODS,
  calculateStaffActivityPoints,
};
