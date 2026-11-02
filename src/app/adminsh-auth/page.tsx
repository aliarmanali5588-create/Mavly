import AdminAuthPage from "../adminsh/auth/page";
import { redirect } from "next/navigation";
import { createSupabaseServerClient, getRequestUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AdminAuthRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const queryError = Array.isArray(params.error) ? params.error[0] : params.error;
  const user = await getRequestUser();
  let initialError = queryError ?? null;

  if (user) {
    const supabase = await createSupabaseServerClient();
    if (supabase) {
      const { data, error } = await supabase.rpc("current_user_admin_status");
      if (!error && data === "active") redirect("/adminsh/dashboard");
      if (!error && data === "unauthorized") {
        return <AdminAuthPage initialError="unauthorized" />;
      }
      if (error) initialError = "admin_schema_missing";
    }
  }

  return <AdminAuthPage initialError={initialError} />;
}
