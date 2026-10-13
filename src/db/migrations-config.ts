// Where CAW's migrations are and where it records which ones ran. CAW shares a database with Blueprint, whose own journal is
// drizzle's default `drizzle.__drizzle_migrations`: two apps in one journal would each skip the other's next migration. So
// CAW's journal is `caw.__caw_migrations`, inside its own schema. Both migrate call sites use this one object.
export const MIGRATIONS = {
  migrationsFolder: new URL("./migrations", import.meta.url).pathname,
  migrationsSchema: "caw",
  migrationsTable: "__caw_migrations",
};
