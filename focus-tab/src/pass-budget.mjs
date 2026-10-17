function localDay(now) {
  const date = new Date(now);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function normalizePassBudget(saved, now = Date.now()) {
  const day = localDay(now);
  return {
    day,
    usedMinutes:
      saved?.day === day &&
      Number.isInteger(saved.usedMinutes) &&
      saved.usedMinutes >= 0
        ? saved.usedMinutes
        : 0,
    lastPassEnds:
      Number.isFinite(saved?.lastPassEnds) && saved.lastPassEnds > 0
        ? saved.lastPassEnds
        : 0,
  };
}

export function describePassBudget(config, saved, now = Date.now()) {
  const record = normalizePassBudget(saved, now);
  const enabled = config.temporaryPassEnabled;
  const dailyLimitMinutes = config.passDailyMinutes;
  const remainingMinutes =
    dailyLimitMinutes === 0
      ? null
      : Math.max(0, dailyLimitMinutes - record.usedMinutes);
  const cooldownUntil =
    record.lastPassEnds && config.passCooldownMinutes > 0
      ? record.lastPassEnds + config.passCooldownMinutes * 60000
      : 0;
  const grantMinutes = enabled
    ? Math.min(config.allowMinutes, remainingMinutes ?? Infinity)
    : 0;
  const canGrant = enabled && grantMinutes > 0 && cooldownUntil <= now;
  const date = new Date(now);
  const midnight = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + 1
  ).getTime();
  const nextAvailableAt = !enabled
    ? null
    : Math.max(now, cooldownUntil, grantMinutes > 0 ? now : midnight);
  let reason;
  if (!enabled) reason = "临时放行已关闭。";
  else if (grantMinutes <= 0)
    reason = "今日临时放行总额度已用完，零点重置；冷却限制仍保留。";
  else if (cooldownUntil > now && record.lastPassEnds > now)
    reason = "已有临时放行尚未到期，所有站点与标签页共享同一限制。";
  else if (cooldownUntil > now)
    reason = "临时放行正在冷却，不能通过新开标签页绕过。";
  else if (grantMinutes < config.allowMinutes)
    reason = `今日剩余 ${grantMinutes} 分钟，本次只批准 ${grantMinutes} 分钟。`;
  else
    reason = `本次可放行 ${grantMinutes} 分钟，批准即计入今日共享额度，提前结束不退回。`;
  return {
    enabled,
    dailyLimitMinutes,
    usedMinutes: record.usedMinutes,
    remainingMinutes,
    cooldownMinutes: config.passCooldownMinutes,
    cooldownUntil,
    waitSeconds:
      nextAvailableAt === null
        ? 0
        : Math.max(0, Math.ceil((nextAvailableAt - now) / 1000)),
    nextAvailableAt,
    canGrant,
    grantMinutes,
    reason,
  };
}

export function reservePass(config, saved, now = Date.now()) {
  const budget = describePassBudget(config, saved, now);
  if (!budget.canGrant) throw new Error(budget.reason);
  const previous = normalizePassBudget(saved, now);
  return {
    previous,
    next: {
      ...previous,
      usedMinutes: previous.usedMinutes + budget.grantMinutes,
      lastPassEnds: Math.max(
        previous.lastPassEnds,
        now + budget.grantMinutes * 60000
      ),
    },
    minutes: budget.grantMinutes,
    until: now + budget.grantMinutes * 60000,
  };
}
