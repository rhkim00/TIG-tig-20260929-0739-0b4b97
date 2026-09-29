export interface Config {
  databaseUrl: string;
  origin: string;
  production: boolean;
  devMode: boolean;
  // Accept/start/submit Git requests as unverified local trials (no isolated
  // runner). Always on in development; opt-in (TIG_LOCAL_TRIAL=true) elsewhere,
  // e.g. a staging server where two real GitHub users exercise a cycle.
  localTrial: boolean;
  githubClientId?: string;
  githubClientSecret?: string;
  port: number;
  host: string;
}
export function configFromEnv(): Config {
  const production = process.env.NODE_ENV === "production",
    devMode = process.env.TIG_DEV_MODE === "true";
  const origin = new URL(process.env.APP_ORIGIN ?? "http://localhost:4173")
    .origin;
  const host = process.env.HOST ?? "127.0.0.1";
  if (
    devMode &&
    (production ||
      !["127.0.0.1", "localhost", "::1"].includes(new URL(origin).hostname) ||
      !["127.0.0.1", "localhost", "::1"].includes(host))
  )
    throw new Error(
      "Development mode must be loopback-only and non-production",
    );
  if (production && !origin.startsWith("https://"))
    throw new Error("Production requires an HTTPS origin");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  return {
    databaseUrl: process.env.DATABASE_URL,
    origin,
    production,
    devMode,
    localTrial: devMode || process.env.TIG_LOCAL_TRIAL === "true",
    githubClientId: process.env.GITHUB_CLIENT_ID,
    githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
    port: Number(process.env.PORT ?? 4310),
    host,
  };
}
