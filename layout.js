export const LOGICAL_WIDTH = 1920;
export const LOGICAL_HEIGHT = 1080;

const clamp = (value, minimum, maximum) =>
  Math.min(Math.max(value, minimum), maximum);

export function outputSize(value) {
  const match = /^(\d+)x(\d+)$/.exec(value ?? "");
  if (!match) return { width: LOGICAL_WIDTH, height: LOGICAL_HEIGHT };
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function logicalToPhysical(value, output, reference) {
  return Math.round(value * output / reference);
}

export function ahiRect({ centerX, centerY, width, height = 5000 }) {
  const pixelWidth = width * LOGICAL_WIDTH / 10000;
  const pixelHeight = height * LOGICAL_HEIGHT / 10000;
  const centerPixelX = centerX * LOGICAL_WIDTH / 10000;
  const centerPixelY = centerY * LOGICAL_HEIGHT / 10000;
  return {
    x: centerPixelX - pixelWidth / 2,
    y: centerPixelY - pixelHeight / 2,
    width: pixelWidth,
    height: pixelHeight,
  };
}

export function sticksRect({ x, y, sizePercent }) {
  return {
    x,
    y,
    width: 560 * sizePercent / 100,
    height: 300 * sizePercent / 100,
  };
}

export function statusRect({
  x, y, sizePercent, showVtxTemperature, showVrxTemperature,
  showVtxVoltage, showVrxVoltage,
}) {
  const scale = sizePercent / 100;
  const rows = Number(showVtxTemperature || showVtxVoltage) +
    Number(showVrxTemperature || showVrxVoltage);
  const bothMetrics = (showVtxTemperature || showVrxTemperature) &&
    (showVtxVoltage || showVrxVoltage);
  return {
    x,
    y,
    width: (bothMetrics ? 260 : 175) * scale,
    height: (18 + Math.max(rows, 1) * 31) * scale,
  };
}

export function clampPosition(x, y, width, height) {
  return {
    x: clamp(x, 0, Math.max(0, LOGICAL_WIDTH - width)),
    y: clamp(y, 0, Math.max(0, LOGICAL_HEIGHT - height)),
  };
}

export function ahiCenterFromPosition(x, y, width, height) {
  return {
    centerX: Math.round((x + width / 2) * 10000 / LOGICAL_WIDTH),
    centerY: Math.round((y + height / 2) * 10000 / LOGICAL_HEIGHT),
  };
}
