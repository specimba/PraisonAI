// r216: SQLite fixture helper for the attention-scroll browser QA.
// Plants/cleans ONE disposable AutomationWorkflow row ("qa-attention-dummy")
// so the r212 pulse attention branches have data to render:
//   plant-breaker → enabled:false, failStreak:3   (breaker-parked branch)
//   plant-stale   → enabled:true, nextRunAt 25h old, failStreak:0 (stale branch)
//   clean         → delete the row (leave the DB byte-clean)
// Run: bun scripts/qa-attention-fixture.ts <command>
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const ID = "qa-attention-dummy";
const cmd = process.argv[2] ?? "";

async function main() {
  if (cmd === "plant-breaker") {
    await db.automationWorkflow.upsert({
      where: { id: ID },
      update: { enabled: false, failStreak: 3, nextRunAt: new Date(Date.now() - 26 * 3_600_000) },
      create: {
        id: ID,
        name: "QA attention dummy (disposable)",
        task: "fixture row for the r216 attention-scroll browser QA — delete any time",
        stepsJson: "[]",
        intervalMs: 900_000,
        enabled: false,
        failStreak: 3,
        nextRunAt: new Date(Date.now() - 26 * 3_600_000),
      },
    });
    console.log("FIXTURE: breaker row planted");
  } else if (cmd === "plant-stale") {
    await db.automationWorkflow.upsert({
      where: { id: ID },
      update: { enabled: true, failStreak: 0, nextRunAt: new Date(Date.now() - 25 * 3_600_000) },
      create: {
        id: ID,
        name: "QA attention dummy (disposable)",
        task: "fixture row for the r216 attention-scroll browser QA — delete any time",
        stepsJson: "[]",
        intervalMs: 900_000,
        enabled: true,
        failStreak: 0,
        nextRunAt: new Date(Date.now() - 25 * 3_600_000),
      },
    });
    console.log("FIXTURE: stale row planted");
  } else if (cmd === "clean") {
    await db.automationWorkflow.deleteMany({ where: { id: ID } });
    console.log("FIXTURE: cleaned");
  } else {
    console.error("usage: bun scripts/qa-attention-fixture.ts <plant-breaker|plant-stale|clean>");
    process.exit(2);
  }
}

main()
  .catch((e) => {
    console.error("FIXTURE-ERROR:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
