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

const EVOLUTION_BLOCKED_PATTERNS: Array<[RegExp, string]> = [
  [/\bdrop\s+(table|schema|view|function|type|index)\b/i, "destructive DROP operations require explicit review"],
  [/\balter\s+table\b[\s\S]*\bdrop\s+(column|constraint)\b/i, "dropping columns or constraints requires explicit review"],
  [/\balter\s+table\b[\s\S]*\balter\s+column\b[\s\S]*\btype\b/i, "column type changes require explicit review"],
  [/\balter\s+table\b[\s\S]*\balter\s+column\b[\s\S]*\bset\s+not\s+null\b/i, "new NOT NULL requirements on existing columns require explicit review"],
  [/\balter\s+table\b[\s\S]*\brename\b/i, "renames require explicit review"],
  [/\balter\s+table\b[\s\S]*\badd\s+constraint\b/i, "new constraints on existing data require explicit review"],
  [/\bcreate\s+unique\s+index\b/i, "new unique indexes on existing data require explicit review"],
  [/\b(insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+(?:public\.)?/i, "production data mutations are not allowed in automatic schema evolution"],
];

const ALLOWED_EXTENSIONS = new Set(["pgcrypto", "uuid-ossp", "pg_trgm", "vector", "citext", "unaccent"]);

export function validateGeneratedMigration(sql: string, mode: "initial" | "evolution" = "initial") {
  if (!sql.trim()) throw new Error("Migration is empty");
  if (sql.length > 500_000) throw new Error("Migration exceeds the 500 KB SQL limit");

  for (const [pattern, reason] of BLOCKED_PATTERNS) {
    if (pattern.test(sql)) throw new Error(`Unsafe generated migration: ${reason}`);
  }

  if (mode === "evolution") {
    for (const [pattern, reason] of EVOLUTION_BLOCKED_PATTERNS) {
      if (pattern.test(sql)) throw new Error(`Unsafe automatic schema evolution: ${reason}`);
    }
    validateAddColumnSafety(sql);
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

function validateAddColumnSafety(sql: string) {
  const additions = sql.matchAll(/\balter\s+table\b[\s\S]*?\badd\s+column\b([^;]*);/gi);
  for (const match of additions) {
    const definition = match[1] || "";
    if (/\bnot\s+null\b/i.test(definition) && !/\bdefault\b/i.test(definition)) {
      throw new Error("Unsafe automatic schema evolution: adding a NOT NULL column without a DEFAULT may fail on existing rows");
    }
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
