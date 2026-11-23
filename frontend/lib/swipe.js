// How far and how straight a finger must move sideways to count as "go back", so a
// scroll that drifts a little, or a short slip of the finger, never leaves the page.
const MIN_DISTANCE = 80;
const MAX_TIME_MS = 800;

// A swipe toward the end side of the line means "back": left to right in English, right
// to left in Hebrew, the way the ← of the Back button points in each.
export function isSwipeBack({ dx, dy, ms, dir }) {
  if (ms > MAX_TIME_MS) return false;
  if (Math.abs(dx) < MIN_DISTANCE || Math.abs(dx) < 2 * Math.abs(dy)) return false;
  return dir === 'rtl' ? dx < 0 : dx > 0;
}
