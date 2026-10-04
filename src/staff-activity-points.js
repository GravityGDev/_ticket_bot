function calculateStaffActivityPoints(tickets, messages, settings, override = null) {
  const calculatedTicketPoints = tickets * settings.ticketClaimPoints;
  const calculatedMessagePoints = messages * settings.trackedMessagePoints;
  const ticketPointsManual = Number.isFinite(override?.ticketPoints);
  const messagePointsManual = Number.isFinite(override?.messagePoints);
  const ticketPoints = ticketPointsManual ? override.ticketPoints : calculatedTicketPoints;
  const messagePoints = messagePointsManual ? override.messagePoints : calculatedMessagePoints;
  return {
    calculatedTicketPoints, calculatedMessagePoints,
    ticketPoints, messagePoints, ticketPointsManual, messagePointsManual,
    activityScore: ticketPoints + messagePoints,
  };
}

module.exports = { calculateStaffActivityPoints };
