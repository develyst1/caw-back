import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { type Blueprint, createBlueprint } from "./blueprint/client";
import type { Db } from "./db/client";
import { createFollower, type Follower } from "./follow/pull";
import { actorRule, type Env } from "./http/actor";
import { onError, unknownRoute, validationHook } from "./http/errors";
import { cardRoutes } from "./http/routes/cards";
import { chatRoutes } from "./http/routes/chat";
import { chainRoutes } from "./http/routes/chain";
import { followRoutes } from "./http/routes/follow";
import { hopRoutes } from "./http/routes/hops";
import { outputRoutes } from "./http/routes/output";
import { proposalRoutes } from "./http/routes/proposals";
import { seamRoutes } from "./http/routes/seam";
import { createTeamStatus, teamRoutes, type TeamStatusHolder } from "./http/routes/team";
import { projectRoutes } from "./http/routes/projects";
import { workerRoutes } from "./http/routes/workers";

const DOCUMENT = { openapi: "3.1.0", info: { title: "CAW API", version: "1.0.0" } };

export function createApp(db: Db, deps: { blueprint?: Blueprint; follow?: Follower; team?: TeamStatusHolder } = {}): OpenAPIHono<Env> {
  const blueprint = deps.blueprint ?? createBlueprint(); // no call happens until a route needs one
  const follow = deps.follow ?? createFollower(db, blueprint); // started by index.ts, not here
  const team = deps.team ?? createTeamStatus(); // in memory, one per app (SPEC-A-009 § R1b)
  const app = new OpenAPIHono<Env>({ defaultHook: validationHook });
  app.get("/health", (c) => c.json({ ok: true }));
  app.use("/v1/*", actorRule(db));
  projectRoutes(app, db, blueprint);
  workerRoutes(app, db);
  chainRoutes(app, db);
  cardRoutes(app, db, blueprint);
  hopRoutes(app, db, blueprint); // + blueprint: a card hop's spec is pinned at its start (REQ-105, SPEC-107 D5)
  outputRoutes(app, db);
  chatRoutes(app, db);
  proposalRoutes(app, db, blueprint);
  seamRoutes(app, db, blueprint);
  followRoutes(app, follow);
  teamRoutes(app, team);

  // The document is generated from the route schemas above, and lists itself.
  app.openapi(createRoute({
    method: "get", path: "/v1/openapi.json",
    responses: { 200: { description: "this API's OpenAPI 3.1 document", content: { "application/json": { schema: z.looseObject({ openapi: z.string() }) } } } },
  }), (c) => c.json(app.getOpenAPI31Document(DOCUMENT), 200));

  app.notFound(unknownRoute);
  app.onError(onError);
  return app;
}
