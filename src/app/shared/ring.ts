/** The stroke-dasharray that fills `part` of `whole` of a ring: the r=27 circle both rings draw in a 64×64 viewBox. */
export function ringDash(part: number, whole: number) {
  const circumference = 2 * Math.PI * 27;
  return `${(circumference * part) / whole} ${circumference}`;
}
