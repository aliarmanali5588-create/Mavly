/**
 * Mavly-owned public hostnames.
 *
 * A project's public address is derived from its globally unique, immutable
 * project id: `<project-id>.mavly.xyz`. No client-supplied value is ever used
 * to build a hostname, and the same id always resolves to the same address.
 *
 * The slug is validated with the same structural guard used on read paths. A
 * project id that cannot be routed cannot be published on a Mavly hostname.
 */

import { isRoutableProjectSlug } from "./project-slug";
import { isReservedLabel } from "./reserved-hostnames";

export const MAVLY_PUBLIC_DOMAIN = "mavly.xyz";

export function mavlyHostname(projectId: string): string | null {
  const slug = projectId.trim().toLowerCase();
  if (!isRoutableProjectSlug(slug)) return null;
  /**
   * ⚠️ A RESERVED LABEL HAS NO MAVLY ADDRESS. `www`, `api`, `admin` and friends
   * belong to the platform, so a publish must fail BEFORE any provider or
   * database resource is created for them. This does not rename or unpublish an
   * existing project: it simply cannot claim a new Mavly hostname.
   */
  if (isReservedLabel(slug)) return null;
  return `${slug}.${MAVLY_PUBLIC_DOMAIN}`;
}
