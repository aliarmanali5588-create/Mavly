import { adminError, adminJson } from "@/lib/admin/http";
import { createSupabaseServerClient, getRequestUser } from "@/lib/supabase/server";

/**
 * Finish an email/password admin sign-in.
 *
 * This endpoint is deliberately outside `/api/adminsh/*`: every admin data and
 * mutation endpoint remains protected by `requireAdmin()`. This narrow login
 * bootstrap can only create the caller's own grant, and the database function
 * derives the UUID, confirmed email and Auth session_id itself.
 */
export async function POST() {
  const user = await getRequestUser();
  if (!user) return adminError(401, "UNAUTHENTICATED", "Sign in required.");

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return adminError(503, "BACKEND_NOT_CONFIGURED", "Supabase is not configured on this deployment.");
  }

  try {
    const { data, error } = await supabase.rpc("start_admin_session");
    if (error) {
      if (error.code === "42501") {
        return adminError(403, "FORBIDDEN", "This account is not authorized to access the Mavly Admin Panel.");
      }
      return adminError(
        503,
        "ADMIN_SCHEMA_MISSING",
        "The admin authentication schema is not installed. Apply supabase/migrations/55_admin_authentication.sql.",
      );
    }
    if (data !== true) return adminError(403, "FORBIDDEN", "This account is not authorized to access the Mavly Admin Panel.");
    return adminJson({ ok: true, data: { active: true } });
  } catch {
    return adminError(503, "ADMIN_CHECK_UNAVAILABLE", "The admin check could not be completed.");
  }
}
