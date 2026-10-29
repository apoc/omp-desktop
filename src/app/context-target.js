/* Pure target geometry and draft ownership, shared by the card and Settings. */
(function () {
  const fields = ["enabled", "method", "asyncEnabled", "midTurnEnabled"];
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const owner = (policy) =>
    policy?.supported
      ? JSON.stringify([
          policy.profileId,
          policy.sessionId,
          policy.sessionFile,
          policy.model?.provider,
          policy.model?.id,
        ])
      : null;
  const modelKey = (policy) =>
    policy?.model?.provider && policy.model.id
      ? `${policy.model.provider}/${policy.model.id}`
      : null;
  const bounds = (policy) => {
    const value = policy?.budgetBounds?.percent;
    return finite(value?.min) && finite(value?.max) && value.min <= value.max
      ? { min: value.min, max: value.max }
      : null;
  };
  const values = (policy) =>
    Object.fromEntries(
      (policy?.controls || [])
        .filter((control) => fields.includes(control.id))
        .map((control) => [control.id, control.value]),
    );
  function createDraft(policy) {
    if (!owner(policy) || !bounds(policy) || !finite(policy.target?.percent))
      return null;
    const initial = values(policy);
    return {
      owner: owner(policy),
      modelKey: modelKey(policy),
      revision: policy.revision,
      initial,
      values: { ...initial },
      percent: String(policy.target.percent),
      targetChange: "untouched",
    };
  }
  function stale(draft, policy, usageModelKey) {
    return (
      !draft ||
      !owner(policy) ||
      draft.owner !== owner(policy) ||
      draft.revision !== policy.revision ||
      (!!usageModelKey && usageModelKey !== draft.modelKey)
    );
  }
  const dirty = (draft) =>
    !!draft &&
    (draft.targetChange !== "untouched" ||
      fields.some(
        (field) => !Object.is(draft.values[field], draft.initial[field]),
      ));
  function requestValues(draft, policy) {
    const result = {};
    for (const field of fields) {
      if (!Object.is(draft.values[field], draft.initial[field]))
        result[field] = draft.values[field];
    }
    if (draft.targetChange === "reset") result.targetPercent = null;
    if (draft.targetChange === "percent") {
      const limit = bounds(policy),
        text = String(draft.percent).trim(),
        percent = Number(text);
      if (
        !limit ||
        !text ||
        !Number.isFinite(percent) ||
        percent < limit.min ||
        percent > limit.max
      )
        throw new Error(
          limit
            ? `Enter a percentage between ${limit.min} and ${limit.max}.`
            : "Target bounds are unavailable.",
        );
      result.targetPercent = percent;
    }
    return result;
  }
  // 270-degree sweep: 0 at lower left, 100 at lower right.
  const angleFor = (percent) => 225 + clamp(percent, 0, 100) * 2.7;
  function point(percent, radius, center) {
    const angle = (angleFor(percent) * Math.PI) / 180;
    return {
      x: center + radius * Math.sin(angle),
      y: center - radius * Math.cos(angle),
    };
  }
  const pointerAngle = (x, y, centerX, centerY) =>
    ((Math.atan2(x - centerX, centerY - y) * 180) / Math.PI + 360) % 360;
  function pointerHit(x, y, centerX, centerY, radius) {
    if (!(radius > 0)) return false;
    const distance = Math.hypot(x - centerX, y - centerY);
    if (distance < (radius * 55) / 72 || distance > radius) return false;
    const sweep = (pointerAngle(x, y, centerX, centerY) - 225 + 360) % 360;
    return sweep <= 270 + 1e-9 || sweep >= 360 - 1e-9;
  }
  function startDrag(x, y, centerX, centerY, limit) {
    const angle = pointerAngle(x, y, centerX, centerY);
    let sweep = (angle - 225 + 360) % 360;
    if (sweep > 270) sweep = sweep < 315 ? 270 : 0;
    const percent = clamp(
      Math.round((sweep / 2.7) * 100) / 100,
      limit.min,
      limit.max,
    );
    return { angle, sweep, percent };
  }
  function moveDrag(drag, x, y, centerX, centerY, limit) {
    const angle = pointerAngle(x, y, centerX, centerY);
    const delta = ((angle - drag.angle + 540) % 360) - 180;
    const sweep = drag.sweep + delta;
    const percent = clamp(
      Math.round((clamp(sweep, 0, 270) / 2.7) * 100) / 100,
      limit.min,
      limit.max,
    );
    return { angle, sweep, percent };
  }
  function keyPercent(key, current, limit) {
    const delta = {
      ArrowRight: 1,
      ArrowUp: 1,
      ArrowLeft: -1,
      ArrowDown: -1,
      PageUp: 10,
      PageDown: -10,
    }[key];
    if (key === "Home") return limit.min;
    if (key === "End") return limit.max;
    return delta == null
      ? null
      : clamp(Math.round((current + delta) * 100) / 100, limit.min, limit.max);
  }
  window.OMP_CONTEXT_TARGET = {
    owner,
    modelKey,
    bounds,
    createDraft,
    stale,
    dirty,
    requestValues,
    clamp,
    angleFor,
    point,
    pointerHit,
    startDrag,
    moveDrag,
    keyPercent,
  };
})();
