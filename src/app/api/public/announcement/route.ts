import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { SUPABASE_ANON_KEY, SUPABASE_URL, isSupabaseConfigured } from "@/lib/supabase/config";

export const dynamic = "force-dynamic";

const PUBLIC_HEADERS = {
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
} as const;

/**
 * Public, read-only announcement boundary. It uses only the public Supabase
 * anon key; the database function is the authority and returns message text
 * only when the admin has enabled a non-empty announcement.
 */
export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ ok: true, data: null }, { headers: PUBLIC_HEADERS });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    });
    const { data, error } = await supabase.rpc("active_announcement_banner");

    if (error) {
      console.error("[public] announcement read failed", { databaseCode: error.code ?? "unknown" });
      return NextResponse.json(
        { ok: false, code: "ANNOUNCEMENT_UNAVAILABLE", data: null },
        { status: 503, headers: PUBLIC_HEADERS },
      );
    }

    if (data === null) {
      return NextResponse.json({ ok: true, data: null }, { headers: PUBLIC_HEADERS });
    }

    if (
      typeof data !== "object" ||
      Array.isArray(data) ||
      typeof (data as { message?: unknown }).message !== "string" ||
      (data as { message: string }).message.trim() === ""
    ) {
      console.error("[public] announcement read returned an invalid payload");
      return NextResponse.json(
        { ok: false, code: "ANNOUNCEMENT_INVALID_RESPONSE", data: null },
        { status: 503, headers: PUBLIC_HEADERS },
      );
    }

    return NextResponse.json(
      { ok: true, data: { message: (data as { message: string }).message } },
      { headers: PUBLIC_HEADERS },
    );
  } catch {
    return NextResponse.json(
      { ok: false, code: "ANNOUNCEMENT_UNAVAILABLE", data: null },
      { status: 503, headers: PUBLIC_HEADERS },
    );
  }
}
