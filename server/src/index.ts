import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { loadConfig } from "./config.js";
import {
  initDrizzle,
  closeDrizzle,
  getDbStatus,
  getDb,
} from "./drizzle-instance.js";
import projectIdPlugin from "./plugins/project-id.js";
import {
  healthPlugin,
  agentsPlugin,
  messagesPlugin,
  ubtPlugin,
  buildPlugin,
  tasksPlugin,
  filesPlugin,
  searchPlugin,
  buildsPlugin,
  coalescePlugin,
  syncPlugin,
  roomsPlugin,
  teamsPlugin,
  projectsPlugin,
  configPlugin,
  branchOpsPlugin,
  hooksPlugin,
  containerSettingsPlugin,
  tasksIngestPlugin,
  exitClassifyPlugin,
  statusPlugin,
  agentDefinitionsPlugin,
} from "./routes/index.js";
import { sweepStaleLock } from "./routes/ubt.js";
import { seedFromConfig } from "./queries/projects.js";

// Pin to local PGlite — ignore any inherited DATABASE_URL until the Supabase migration is ready.
// Remove this line when you want this project to honor the env var again.
delete process.env.DATABASE_URL;

const config = loadConfig();
const pgliteDataDir = "./data/pglite";
await initDrizzle({ pgliteDataDir });

// Seed projects from config into DB (INSERT-only, skip existing)
{
  const db = getDb();
  const projectEntries = Object.entries(config.resolvedProjects).map(
    ([id, proj]) => ({
      id,
      name: proj.name,
    }),
  );
  const { inserted, skipped, invalid } = await seedFromConfig(
    db,
    projectEntries,
  );
  if (inserted.length > 0) {
    console.log(`Seeded projects: ${inserted.join(", ")}`);
  }
  if (skipped.length > 0) {
    console.log(`Skipped existing projects: ${skipped.join(", ")}`);
  }
  if (invalid.length > 0) {
    console.error(
      `Invalid project IDs skipped during seed: ${invalid.join(", ")}`,
    );
  }
}

const server = Fastify({
  logger: true,
  requestTimeout: 0,
});

await server.register(sensible);
await server.register(projectIdPlugin);
await server.register(healthPlugin, { config, pgliteDataDir });
await server.register(agentsPlugin, { config });
await server.register(messagesPlugin);
await server.register(ubtPlugin, { config });
await server.register(buildPlugin, { config });
await server.register(tasksPlugin, { config });
await server.register(filesPlugin);
await server.register(searchPlugin);
await server.register(buildsPlugin);
await server.register(coalescePlugin);
await server.register(syncPlugin, { config });
await server.register(roomsPlugin);
await server.register(teamsPlugin, { config });
await server.register(projectsPlugin);
await server.register(configPlugin, { config });
await server.register(branchOpsPlugin, { config });
await server.register(hooksPlugin);
await server.register(containerSettingsPlugin);
await server.register(tasksIngestPlugin, { config });
await server.register(exitClassifyPlugin);
await server.register(statusPlugin);
await server.register(agentDefinitionsPlugin, { config });

try {
  const address = await server.listen({
    port: config.server.port,
    host: "0.0.0.0",
  });
  console.log(`Coordination server listening at ${address}`);
  const projectIds = Object.keys(config.resolvedProjects);
  if (projectIds.length > 1) {
    console.log(`  Projects: ${projectIds.join(", ")}`);
  } else {
    const singleId = projectIds[0];
    console.log(
      `  Project: ${config.resolvedProjects[singleId]?.name ?? singleId}`,
    );
  }
  const dbStatus = getDbStatus();
  console.log(
    `  DB: ${dbStatus.backend}${dbStatus.backend === "pglite" ? ` (${pgliteDataDir})` : ""}`,
  );
  console.log(`  UBT lock timeout: ${config.server.ubtLockTimeoutMs}ms`);

  setInterval(() => {
    sweepStaleLock().catch((err) => {
      server.log.error(err, "UBT stale-lock sweep failed");
    });
  }, 60_000);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down gracefully…`);
    await server.close();
    await closeDrizzle();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
} catch (err) {
  server.log.error(err);
  process.exit(1);
}
