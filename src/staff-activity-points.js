const POINT_PERIODS = Object.freeze([
  'weekly',
  'monthly',
  'quarterly',
  'lifetime',
]);

function cleanPointPeriod(periodKey) {
  return POINT_PERIODS.includes(periodKey) ? periodKey : 'lifetime';
}

function getManualMetricValue(
  automaticValue,
  override,
  valueField,
  baselineField,
  periodKey,
) {
  const manualValue = override?.[valueField];

  if (!Number.isFinite(manualValue)) {
    return {
      value: automaticValue,
      manual: false,
      baseline: null,
      adjustment: 0,
    };
  }

  const period = cleanPointPeriod(periodKey);
  const savedBaseline = override?.[baselineField]?.[period];

  // Legacy/manual records without a stored baseline are anchored by the store
  // before normal reads. This fallback keeps rendering safe if a record is
  // observed before that migration completes.
  const baseline = Number.isFinite(savedBaseline)
    ? Number(savedBaseline)
    : automaticValue;

  const adjustment = Number(manualValue) - baseline;
  const value = Math.max(0, automaticValue + adjustment);

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
  const automaticTicketClaims = Math.max(0, Number(tickets) || 0);
  const automaticTrackedMessages = Math.max(0, Number(messages) || 0);

  // Display counts are independent from scoring. Admins can correct the shown
  // claim/message totals without changing ticket/message points or rank score.
  const ticketClaims = getManualMetricValue(
    automaticTicketClaims,
    override,
    'ticketClaims',
    'ticketClaimsBaselines',
    periodKey,
  );

  const trackedMessages = getManualMetricValue(
    automaticTrackedMessages,
    override,
    'trackedMessages',
    'trackedMessagesBaselines',
    periodKey,
  );

  const calculatedTicketPoints =
    automaticTicketClaims * settings.ticketClaimPoints;
  const calculatedMessagePoints =
    automaticTrackedMessages * settings.trackedMessagePoints;

  const ticketPoints = getManualMetricValue(
    calculatedTicketPoints,
    override,
    'ticketPoints',
    'ticketPointsBaselines',
    periodKey,
  );

  const messagePoints = getManualMetricValue(
    calculatedMessagePoints,
    override,
    'messagePoints',
    'messagePointsBaselines',
    periodKey,
  );

  return {
    calculatedTicketClaims: automaticTicketClaims,
    calculatedTrackedMessages: automaticTrackedMessages,
    ticketClaims: ticketClaims.value,
    trackedMessages: trackedMessages.value,
    ticketClaimsManual: ticketClaims.manual,
    trackedMessagesManual: trackedMessages.manual,
    ticketClaimsBaseline: ticketClaims.baseline,
    trackedMessagesBaseline: trackedMessages.baseline,
    ticketClaimsAdjustment: ticketClaims.adjustment,
    trackedMessagesAdjustment: trackedMessages.adjustment,

    calculatedTicketPoints,
    calculatedMessagePoints,
    ticketPoints: ticketPoints.value,
    messagePoints: messagePoints.value,
    ticketPointsManual: ticketPoints.manual,
    messagePointsManual: messagePoints.manual,
    ticketPointsBaseline: ticketPoints.baseline,
    messagePointsBaseline: messagePoints.baseline,
    ticketPointsAdjustment: ticketPoints.adjustment,
    messagePointsAdjustment: messagePoints.adjustment,

    // Activity score is intentionally points-only. Manual display corrections
    // to ticket claims / tracked messages never change XP or leaderboard rank.
    activityScore: ticketPoints.value + messagePoints.value,
  };
}

module.exports = {
  POINT_PERIODS,
  calculateStaffActivityPoints,
};
