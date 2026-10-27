export type ProfileSummary = {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
};

export type AuthUserLike = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

const AVATAR_GRADIENTS: ReadonlyArray<readonly [string, string]> = [
  ["#1c1917", "#57534e"],
  ["#292524", "#78716c"],
  ["#3f3f46", "#71717a"],
  ["#44403c", "#a8a29e"],
  ["#27272a", "#52525b"],
  ["#0f172a", "#475569"],
];

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 120) : null;
}

function trustedAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;

    const host = url.hostname.toLowerCase();
    const trusted =
      host === "avatars.githubusercontent.com" ||
      host === "googleusercontent.com" ||
      host.endsWith(".googleusercontent.com");

    return trusted ? url.toString() : null;
  } catch {
    return null;
  }
}

export function profileFromAuthUser(user: AuthUserLike): ProfileSummary {
  const metadata = user.user_metadata ?? {};
  const name =
    cleanText(metadata.full_name) ??
    cleanText(metadata.name);

  return {
    id: user.id,
    email: cleanText(user.email),
    name,
    avatarUrl: trustedAvatarUrl(metadata.avatar_url),
  };
}

export function initialsFor(name: string | null, email: string | null): string | null {
  const source = (name?.trim() || email?.split("@")[0] || "").trim();
  if (!source) return null;

  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return null;

  if (parts.length > 1) {
    return `${Array.from(parts[0])[0] ?? ""}${Array.from(parts[1])[0] ?? ""}`.toUpperCase() || null;
  }

  const letters = Array.from(parts[0]).filter((character) => /[\p{L}\p{N}]/u.test(character));
  return letters.slice(0, 2).join("").toUpperCase() || null;
}

export function avatarGradientFor(seed: string): readonly [string, string] {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
}
