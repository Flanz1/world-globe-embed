/**
 * Ports for a suite's servers. Standalone they are the historical 4173…4181; the parallel runner
 * (run.mjs) sets E2E_PORT_BASE so each suite gets its own range and suites can't collide.
 * port(n) is base + (n - 4173), so port(4173) is the suite's main site.
 */
const BASE = Number(process.env.E2E_PORT_BASE) || 4173;
export const port = (historical) => BASE + (historical - 4173);
