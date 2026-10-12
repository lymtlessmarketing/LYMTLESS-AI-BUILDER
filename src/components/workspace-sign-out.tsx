"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function WorkspaceSignOut({ className }: { className?: string }) {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.assign("/");
  }

  return (
    <button type="button" className={className} onClick={signOut} disabled={busy}>
      {busy ? "SIGNING OUT…" : "SIGN OUT ↗"}
    </button>
  );
}
