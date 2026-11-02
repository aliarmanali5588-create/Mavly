import { adminError, adminJson } from "@/lib/admin/http";
import { createSupabaseServerClient, getRequestUser } from "@/lib/supabase/server";

/** Server-side status probe used only to remove an expired admin tab from view. */
export async function GET() {
  const user = await getRequestUser();
  if (!user) return adminError(401, "UNAUTHENTICATED", "Sign in required.");

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return adminError(503, "BACKEND_NOT_CONFIGURED", "Supabase is not configured on this deployment.");
  }

  try {
    const { data, error } = await supabase.rpc("current_user_admin_status");
    if (error) {
      return adminError(
        503,
        "ADMIN_SCHEMA_MISSING",
        "The admin authentication schema is not installed. Apply supabase/migrations/55_admin_authentication.sql.",
      );
    }
    if (data === "active") return adminJson({ ok: true, data: { active: true } });
    if (data === "expired") return adminError(401, "ADMIN_SESSION_EXPIRED", "Your admin session expired. Sign in again.");
    if (data === "needs_login") return adminError(401, "ADMIN_AUTHENTICATION_REQUIRED", "Admin authentication required.");
    return adminError(403, "FORBIDDEN", "This account is not authorized to access the Mavly Admin Panel.");
  } catch {
    return adminError(503, "ADMIN_CHECK_UNAVAILABLE", "The admin check could not be completed.");
  }
}
