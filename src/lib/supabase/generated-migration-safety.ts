const BLOCKED_PATTERNS: Array<[RegExp, string]> = [
  [/\bcopy\b[\s\S]*\bprogram\b/i, "COPY PROGRAM is not allowed"],
  [/\b(pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export)\s*\(/i, "server file access is not allowed"],
  [/\b(create|alter|drop)\s+role\b/i, "database role administration is not allowed"],
  [/\balter\s+system\b/i, "ALTER SYSTEM is not allowed"],
  [/\bset\s+(role|session\s+authorization)\b/i, "session privilege changes are not allowed"],
  [/\bsecurity\s+definer\b/i, "SECURITY DEFINER functions require manual review"],
  [/\bcreate\s+event\s+trigger\b/i, "event triggers are not allowed"],
  [/\bcreate\s+(subscription|publication)\b/i, "replication administration is not allowed"],
  [/\bdrop\s+database\b/i, "DROP DATABASE is not allowed"],
  [/\bgrant\s+all\b/i, "GRANT ALL is not allowed"],
  [/\bgrant\b[\s\S]*\bto\s+(postgres|supabase_admin|service_role)\b/i, "grants to privileged platform roles are not allowed"],
  [/\b(create|alter|drop)\s+(table|view|function|schema)\s+(?:"?(?:auth|storage|vault|extensions|supabase_[a-z0-9_]*)"?)(?:\.|\b)/i, "Supabase-managed schemas cannot be modified by generated migrations"],
  [/\b(insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+(?:"?(?:auth|storage|vault|extensions|supabase_[a-z0-9_]*)"?)\./i, "data in Supabase-managed schemas cannot be modified by generated migrations"],
];

// Preview branches are data-less by default. Therefore automatic production evolution is limited
// to changes whose safety does not depend on the contents of production rows. Everything below
// is valid SQL, but requires an explicit human-reviewed migration path before production merge.
const EVOLUTION_MANUAL_REVIEW_PATTERNS: Array<[RegExp, string]> = [
  [/\bdrop\s+(table|schema|view|materialized\s+view|function|type|domain|sequence)\b/i, "DROP operations require manual review"],
  [/\balter\s+table\b[\s\S]*?\bdrop\s+(column|constraint)\b/i, "dropping columns or constraints requires manual review"],
  [/\balter\s+table\b[\s\S]*?\brename\s+(column|to)\b/i, "renaming tables or columns requires manual review"],
  [/\balter\s+table\b[\s\S]*?\balter\s+column\b[\s\S]*?\btype\b/i, "column type changes require manual review"],
  [/\balter\s+table\b[\s\S]*?\balter\s+column\b[\s\S]*?\bset\s+not\s+null\b/i, "SET NOT NULL requires production-data validation"],
  [/\balter\s+table\b[\s\S]*?\badd\s+(?:constraint\s+)?(?:unique|foreign\s+key|primary\s+key|check)\b/i, "new data-validating constraints require manual review"],
  [/\balter\s+table\b[\s\S]*?\badd\s+column\b[\s\S]*?\bnot\s+null\b/i, "adding a NOT NULL column requires production-data validation"],
  [/\bcreate\s+unique\s+index\b/i, "unique indexes require production-data validation"],
  [/\btruncate(?:\s+table)?\b/i, "TRUNCATE requires manual review"],
  [/\binsert\s+into\b/i, "INSERT data migrations require manual review"],
  [/\bdelete\s+from\b/i, "DELETE data migrations require manual review"],
  [/\bupdate\s+(?:public\.)?"?[a-zA-Z_][a-zA-Z0-9_]*"?\s+set\b/i, "UPDATE data migrations require manual review"],
];

const ALLOWED_EXTENSIONS = new Set(["pgcrypto", "uuid-ossp", "pg_trgm", "vector", "citext", "unaccent"]);

type MigrationSafetyOptions = {
  mode?: "initial" | "evolution";
};

export function validateGeneratedMigration(sql: string, options: MigrationSafetyOptions = {}) {
  if (!sql.trim()) throw new Error("Migration is empty");
  if (sql.length > 500_000) throw new Error("Migration exceeds the 500 KB SQL limit");

  for (const [pattern, reason] of BLOCKED_PATTERNS) {
    if (pattern.test(sql)) throw new Error(`Unsafe generated migration: ${reason}`);
  }

  if (options.mode === "evolution") {
    for (const [pattern, reason] of EVOLUTION_MANUAL_REVIEW_PATTERNS) {
      if (pattern.test(sql)) throw new Error(`Automatic schema evolution blocked: ${reason}`);
    }
  }

  const extensionMatches = sql.matchAll(/\bcreate\s+extension(?:\s+if\s+not\s+exists)?\s+"?([a-zA-Z0-9_-]+)"?/gi);
  for (const match of extensionMatches) {
    const name = match[1]?.toLowerCase();
    if (name && !ALLOWED_EXTENSIONS.has(name)) {
      throw new Error(`Unsafe generated migration: extension ${name} is not in the allowlist`);
    }
  }

  const publicTables = Array.from(
    sql.matchAll(/\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+(?:public\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi),
  ).map((match) => match[1]);

  for (const table of publicTables) {
    const escaped = escapeRegExp(table);
    const rls = new RegExp(
      `\\balter\\s+table(?:\\s+if\\s+exists)?\\s+(?:public\\.)?"?${escaped}"?\\s+enable\\s+row\\s+level\\s+security\\b`,
      "i",
    );
    if (!rls.test(sql)) {
      throw new Error(`Unsafe generated migration: table ${table} is created without enabling Row Level Security`);
    }
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
