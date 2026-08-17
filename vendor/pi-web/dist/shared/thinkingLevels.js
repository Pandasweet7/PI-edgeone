/**
 * Known levels in increasing intensity, derived from pi's `ThinkingLevel` union.
 * The `satisfies` clause makes this fail to compile if pi removes or renames a
 * level; thinkingLevels.test.ts adds a compile-time check for additions too. When
 * either breaks, update this list and give the new level a label/description
 * where thinking levels are presented.
 */
export const KNOWN_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export function isKnownThinkingLevel(value) {
    return KNOWN_THINKING_LEVELS.some((level) => level === value);
}
export function thinkingLevelLabel(level) {
    return level === undefined || level === "" ? "off" : level;
}
/**
 * Describe a thinking-level gauge from the available set rather than a hardcoded
 * table, so it stays correct even if pi changes the available levels at runtime.
 *
 * Convention: the first available level is treated as "no thinking". The gauge
 * therefore renders one bar per remaining level, and fills up to the current
 * level's rank. An unknown current level fills 0 bars instead of throwing.
 */
export function thinkingGauge(level, available) {
    const pool = available.length >= 2 ? available : KNOWN_THINKING_LEVELS;
    const total = pool.length - 1;
    const normalized = thinkingLevelLabel(level);
    const index = pool.indexOf(normalized);
    const filled = index <= 0 ? 0 : Math.min(index, total);
    return { total, filled };
}
//# sourceMappingURL=thinkingLevels.js.map