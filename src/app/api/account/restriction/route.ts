import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const PRIVATE_HEADERS = { "cache-control": "private, no-store, max-age=0" };

export async function GET() {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, code: "SUPABASE_NOT_CONFIGURED", error: "Account status is unavailable." },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  }

  try {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user) {
      return NextResponse.json(
        { ok: false, code: "UNAUTHENTICATED", error: "Sign in to check account status." },
        { status: 401, headers: PRIVATE_HEADERS },
      );
    }

    const { data, error } = await supabase.rpc("current_user_is_restricted");
    if (error || typeof data !== "boolean") {
      console.error("[account-restriction] status API lookup failed", {
        code: error?.code ?? "invalid_response",
      });
      return NextResponse.json(
        { ok: false, code: "ACCOUNT_STATUS_UNAVAILABLE", error: "Account status is unavailable." },
        { status: 503, headers: PRIVATE_HEADERS },
      );
    }

    return NextResponse.json(
      { ok: true, data: { restricted: data } },
      { headers: PRIVATE_HEADERS },
    );
  } catch {
    console.error("[account-restriction] status API request failed");
    return NextResponse.json(
      { ok: false, code: "ACCOUNT_STATUS_UNAVAILABLE", error: "Account status is unavailable." },
      { status: 503, headers: PRIVATE_HEADERS },
    );
  }
}
