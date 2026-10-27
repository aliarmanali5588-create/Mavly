/**
 * ═══ ANDROID PROJECT CONTRACT ═══════════════════════════════════════════════
 *
 * The generated Android source is UNTRUSTED. This module re-validates the whole
 * project before it can be reported as a completed run:
 *
 *   · only relative text paths from the Kotlin/Compose profile;
 *   · no binary, keystore, signing or credential-shaped file;
 *   · one manifest, one package, and a matching Gradle namespace/applicationId;
 *   · a resolvable Compose entry point and a launcher activity;
 *   · no cleartext traffic, dangerous permissions, dynamic versions, custom
 *     build-script process execution or non-allowlisted Maven repositories.
 *
 * ⚠️ THIS IS NOT A BUILD. These checks make the source *eligible* for an
 * isolated build; they do not prove it compiles. No Android build executor is
 * configured in this deployment, so `passed` build states cannot be produced.
 *
 * The module is pure: it reads no environment and imports no provider client.
 */

export const ANDROID_MAX_FILES = 80;
export const ANDROID_MAX_FILE_BYTES = 256 * 1024;
export const ANDROID_MAX_TOTAL_BYTES = 1_500_000;
export const ANDROID_MAX_VIOLATIONS = 20;

export const ANDROID_MIN_API = 21;
export const ANDROID_MAX_API = 36;

/** Files every new Android project must contain. */
export const ANDROID_REQUIRED_PATHS = [
  "settings.gradle.kts",
  "build.gradle.kts",
  "app/build.gradle.kts",
  "app/src/main/AndroidManifest.xml",
  "README.md",
] as const;

export const ANDROID_REQUIRED_README = "README.md";

const ALLOWED_EXTENSIONS = new Set([
  "kt",
  "kts",
  "java",
  "xml",
  "gradle",
  "properties",
  "md",
  "txt",
  "json",
  "toml",
  "pro",
  "cfg",
  "yml",
  "yaml",
]);

const ALLOWED_BASENAMES = new Set([
  ".gitignore",
  ".gitattributes",
  "gradlew",
  "gradlew.bat",
  "readme",
  "license",
  "notice",
  "changelog",
]);

const FORBIDDEN_BASENAMES = new Set([
  "local.properties",
  "keystore.properties",
  "signing.properties",
  "google-services.json",
  "secrets.properties",
  ".netrc",
  ".npmrc",
  ".yarnrc",
  ".pypirc",
  "credentials.json",
  "secrets.json",
  "service-account.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

const FORBIDDEN_EXTENSIONS = new Set([
  "jar",
  "aar",
  "so",
  "dex",
  "apk",
  "aab",
  "jks",
  "keystore",
  "p12",
  "pfx",
  "pem",
  "key",
  "zip",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "bmp",
  "mp3",
  "mp4",
  "mov",
  "ttf",
  "otf",
  "woff",
  "woff2",
  "db",
  "sqlite",
  "class",
  "bin",
  "exe",
  "dll",
  "dylib",
]);

const FORBIDDEN_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".gradle",
  ".idea",
  "build",
  ".next",
  ".vercel",
]);

const PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** High-confidence credential shapes; examples in prose are not scanned as secrets. */
const CREDENTIAL_CONTENT =
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/;

const DANGEROUS_PERMISSIONS = [
  "android.permission.READ_SMS",
  "android.permission.SEND_SMS",
  "android.permission.RECEIVE_SMS",
  "android.permission.READ_CALL_LOG",
  "android.permission.WRITE_CALL_LOG",
  "android.permission.READ_CONTACTS",
  "android.permission.WRITE_CONTACTS",
  "android.permission.MANAGE_EXTERNAL_STORAGE",
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.REQUEST_INSTALL_PACKAGES",
  "android.permission.BIND_ACCESSIBILITY_SERVICE",
  "android.permission.BIND_DEVICE_ADMIN",
  "android.permission.READ_PHONE_STATE",
] as const;

const ALLOWED_MAVEN_PREFIXES = [
  "https://dl.google.com/dl/android/maven2/",
  "https://dl.google.com/dl/android/maven2",
  "https://repo.maven.apache.org/maven2/",
  "https://repo.maven.apache.org/maven2",
  "https://plugins.gradle.org/m2/",
  "https://plugins.gradle.org/m2",
];

export interface AndroidSourceFile {
  path: string;
  content: string;
}

export interface AndroidContract {
  packageName: string;
  applicationId: string;
  namespace: string;
  compileSdk: number;
  minSdk: number;
  targetSdk: number;
  mainActivityPath: string;
}

export type AndroidContractFailureCode =
  | "GENERATION_UNSAFE_PATH"
  | "GENERATION_TOO_LARGE"
  | "GENERATION_TOO_MANY_FILES"
  | "GENERATION_CONTRACT_INVALID";

export type AndroidContractOutcome =
  | { ok: true; contract: AndroidContract }
  | {
      ok: false;
      code: AndroidContractFailureCode;
      error: string;
      violations: string[];
    };

/**
 * A deterministic, safe application id derived only from the owned project id.
 * The planner is told to use it, so the Compose entry point path is predictable.
 */
export function androidPackageForProject(projectId: string): string {
  const slug = projectId.toLowerCase().replace(/[^a-z0-9]/g, "");
  const segment = (/^[a-z]/.test(slug) ? slug : `app${slug}`).slice(0, 40);
  return `com.mavly.${segment || "app"}`;
}

export function androidMainActivityPath(packageName: string): string {
  return `app/src/main/java/${packageName.replace(/\./g, "/")}/MainActivity.kt`;
}

function segmentsOf(path: string): string[] | null {
  if (!path || path.length > 512 || path.startsWith("/") || path.includes("\\")) {
    return null;
  }
  if (/[\u0000-\u001f\u007f]/.test(path)) return null;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  if (segments.some((segment) => segment.includes(":"))) return null;
  return segments;
}

/** A reason this path is not part of the Android source profile, or null. */
export function androidPathRejection(path: string): string | null {
  const segments = segmentsOf(path);
  if (!segments) return "the path is not a safe relative project path";

  const lowered = segments.map((segment) => segment.toLowerCase());
  if (lowered.some((segment) => FORBIDDEN_DIRECTORIES.has(segment))) {
    return "the path uses a generated, dependency or build-output directory";
  }

  const base = lowered[lowered.length - 1];
  if (!base) return "the path has no file name";
  if (base === ".env" || base.startsWith(".env.")) {
    return "environment files are not allowed in an Android project";
  }
  if (FORBIDDEN_BASENAMES.has(base)) {
    return "the file is a credential or signing file";
  }
  if (ALLOWED_BASENAMES.has(base)) return null;

  const dot = base.lastIndexOf(".");
  const extension = dot === -1 ? "" : base.slice(dot + 1);
  if (!extension) return "the file type is not supported";
  if (FORBIDDEN_EXTENSIONS.has(extension)) {
    return "binary, installable or signing artifacts are not allowed";
  }
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return "the file type is not part of the Android source profile";
  }
  return null;
}

function withoutComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, "");
}

function parseNumber(source: string, name: string): number | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(\\d{1,2})\\b`).exec(source);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function parseQuoted(source: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`).exec(source);
  return match ? match[1].trim() : null;
}

function isAllowedMavenUrl(raw: string): boolean {
  const value = raw.trim();
  if (!/^https:\/\//i.test(value)) return false;
  return ALLOWED_MAVEN_PREFIXES.some(
    (prefix) => value === prefix || value.startsWith(prefix),
  );
}

function collectMavenUrls(source: string): string[] {
  const urls: string[] = [];
  const patterns = [
    /\burl\s*=\s*uri\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\burl\s*=\s*["']([^"']+)["']/g,
    /\burl\s+["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) urls.push(match[1]);
    }
  }
  return urls;
}

function invalid(
  error: string,
  violations: string[],
): Extract<AndroidContractOutcome, { ok: false }> {
  return {
    ok: false,
    code: "GENERATION_CONTRACT_INVALID",
    error,
    violations: violations.slice(0, ANDROID_MAX_VIOLATIONS),
  };
}

/**
 * Validate the COMPLETE, resulting project state (existing files overlaid with
 * this run's files and deletions). Callers must not pass a context subset.
 */
export function validateAndroidProject(
  files: readonly AndroidSourceFile[],
  expectedPackage?: string | null,
): AndroidContractOutcome {
  if (files.length > ANDROID_MAX_FILES) {
    return {
      ok: false,
      code: "GENERATION_TOO_MANY_FILES",
      error: `An Android project is limited to ${ANDROID_MAX_FILES} files.`,
      violations: [`file count: ${files.length}`],
    };
  }
  if (files.length === 0) {
    return invalid("The Android project has no source files.", ["no files"]);
  }

  const violations: string[] = [];
  const byPath = new Map<string, string>();
  const loweredPaths = new Set<string>();
  let totalBytes = 0;

  for (const file of files) {
    const rejection = androidPathRejection(file.path);
    if (rejection) {
      violations.push(`${file.path}: ${rejection}`);
      continue;
    }
    const lower = file.path.toLowerCase();
    if (loweredPaths.has(lower)) {
      violations.push(`${file.path}: duplicate path`);
      continue;
    }
    loweredPaths.add(lower);

    if (typeof file.content !== "string") {
      violations.push(`${file.path}: content is not text`);
      continue;
    }
    if (file.content.includes("\u0000")) {
      violations.push(`${file.path}: binary content is not allowed`);
      continue;
    }
    if (CREDENTIAL_CONTENT.test(file.content)) {
      violations.push(`${file.path}: credential-shaped content is not allowed`);
      continue;
    }
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > ANDROID_MAX_FILE_BYTES) {
      return {
        ok: false,
        code: "GENERATION_TOO_LARGE",
        error: `${file.path} exceeds the ${ANDROID_MAX_FILE_BYTES}-byte file limit.`,
        violations: [`${file.path}: ${bytes} bytes`],
      };
    }
    totalBytes += bytes;
    if (totalBytes > ANDROID_MAX_TOTAL_BYTES) {
      return {
        ok: false,
        code: "GENERATION_TOO_LARGE",
        error: `The Android project exceeds the ${ANDROID_MAX_TOTAL_BYTES}-byte total limit.`,
        violations: [`total: ${totalBytes} bytes`],
      };
    }
    byPath.set(file.path, file.content);
  }

  if (violations.length > 0) {
    return invalid("The Android project failed its source contract.", violations);
  }

  for (const path of ANDROID_REQUIRED_PATHS) {
    if (!byPath.has(path)) violations.push(`${path}: required file is missing`);
  }

  const manifest = byPath.get("app/src/main/AndroidManifest.xml") ?? "";
  const appGradle = byPath.get("app/build.gradle.kts") ?? "";
  const settings = byPath.get("settings.gradle.kts") ?? "";
  const rootGradle = byPath.get("build.gradle.kts") ?? "";

  if (manifest) {
    if (Buffer.byteLength(manifest, "utf8") > 128 * 1024) {
      violations.push("AndroidManifest.xml is too large");
    }
    const clean = withoutComments(manifest);
    if ((clean.match(/<manifest\b/g) ?? []).length !== 1) {
      violations.push("AndroidManifest.xml must contain exactly one <manifest> element");
    }
    const packageName = parseQuoted(clean, "package");
    if (!packageName || !PACKAGE_PATTERN.test(packageName) || packageName.length > 150) {
      violations.push("AndroidManifest.xml must declare a valid package");
    }
    if (expectedPackage && packageName && packageName !== expectedPackage) {
      violations.push(`manifest package ${packageName} does not match ${expectedPackage}`);
    }
    if (/android:debuggable\s*=\s*["']true["']/i.test(clean)) {
      violations.push("android:debuggable must not be enabled in the manifest");
    }
    if (/android:usesCleartextTraffic\s*=\s*["']true["']/i.test(clean)) {
      violations.push("cleartext network traffic must not be enabled");
    }
    for (const permission of DANGEROUS_PERMISSIONS) {
      if (clean.includes(permission)) {
        violations.push(`restricted permission declared: ${permission}`);
      }
    }

    /**
     * Consume the complete opening tag first, then either a self-closing end or
     * the matching `</activity>`. A lazy scan to `/>` would stop at a nested
     * self-closing `<action ... />` and miss the LAUNCHER category.
     */
    const activities = [
      ...clean.matchAll(/<activity\b[^>]*?(?:\/>|>[\s\S]*?<\/activity>)/g),
    ].map((match) => match[0]);
    const launcher = activities.find(
      (block) =>
        /android:exported\s*=\s*["']true["']/i.test(block) &&
        block.includes("android.intent.action.MAIN") &&
        block.includes("android.intent.category.LAUNCHER"),
    );
    if (activities.length === 0) {
      violations.push("AndroidManifest.xml must declare the launcher activity");
    } else if (!launcher) {
      violations.push("the launcher activity must be exported and handle MAIN/LAUNCHER");
    } else {
      const launcherName =
        /<activity\b[^>]*android:name\s*=\s*["']([^"']+)["']/i.exec(launcher)?.[1] ?? "";
      if (
        launcherName !== "MainActivity" &&
        !launcherName.endsWith(".MainActivity")
      ) {
        violations.push("the launcher activity must be MainActivity");
      }
    }
  }

  if (appGradle) {
    if (!appGradle.includes("com.android.application")) {
      violations.push("app/build.gradle.kts must apply com.android.application");
    }
    if (
      !appGradle.includes("org.jetbrains.kotlin.android") &&
      !appGradle.includes('kotlin("android")')
    ) {
      violations.push("app/build.gradle.kts must apply the Kotlin Android plugin");
    }
    if (
      !appGradle.includes("org.jetbrains.kotlin.plugin.compose") &&
      !appGradle.includes('kotlin("plugin.compose")')
    ) {
      violations.push("app/build.gradle.kts must apply the Compose compiler plugin");
    }
    if (!/\bbuildFeatures\s*\{[\s\S]*?\bcompose\s*=\s*true/.test(appGradle)) {
      violations.push("app/build.gradle.kts must enable buildFeatures { compose = true }");
    }
    if (!appGradle.includes("androidx.compose")) {
      violations.push("app/build.gradle.kts must declare Jetpack Compose dependencies");
    }

    const namespace = parseQuoted(appGradle, "namespace");
    const applicationId = parseQuoted(appGradle, "applicationId");
    const manifestPackage = parseQuoted(withoutComments(manifest), "package");
    for (const [label, value] of [
      ["namespace", namespace],
      ["applicationId", applicationId],
    ] as const) {
      if (!value || !PACKAGE_PATTERN.test(value)) {
        violations.push(`app/build.gradle.kts must declare a valid ${label}`);
      }
    }
    if (manifestPackage) {
      if (namespace && namespace !== manifestPackage) {
        violations.push("Gradle namespace must match the manifest package");
      }
      if (applicationId && applicationId !== manifestPackage) {
        violations.push("Gradle applicationId must match the manifest package");
      }
    }

    const compileSdk = parseNumber(appGradle, "compileSdk");
    const minSdk = parseNumber(appGradle, "minSdk");
    const targetSdk = parseNumber(appGradle, "targetSdk");
    if (compileSdk === null || compileSdk < ANDROID_MIN_API || compileSdk > ANDROID_MAX_API) {
      violations.push(`compileSdk must be between ${ANDROID_MIN_API} and ${ANDROID_MAX_API}`);
    }
    if (minSdk === null || minSdk < ANDROID_MIN_API || minSdk > ANDROID_MAX_API) {
      violations.push(`minSdk must be between ${ANDROID_MIN_API} and ${ANDROID_MAX_API}`);
    }
    if (targetSdk === null || targetSdk < ANDROID_MIN_API || targetSdk > ANDROID_MAX_API) {
      violations.push(`targetSdk must be between ${ANDROID_MIN_API} and ${ANDROID_MAX_API}`);
    }
    if (minSdk !== null && targetSdk !== null && targetSdk < minSdk) {
      violations.push("targetSdk must be at least minSdk");
    }
    if (compileSdk !== null && targetSdk !== null && targetSdk > compileSdk) {
      violations.push("targetSdk must not exceed compileSdk");
    }

    if (/\bsigningConfigs\b|\bstoreFile\b|\bstorePassword\b|\bkeyAlias\b|\bkeyPassword\b/.test(appGradle)) {
      violations.push("release signing configuration is not part of generated Android projects");
    }
    if (
      /\b(?:exec|javaexec|commandLine|ProcessBuilder|Runtime\.getRuntime|System\.exit|System\.getenv)\b/.test(
        appGradle,
      )
    ) {
      violations.push("build scripts must not execute arbitrary processes or read the build environment");
    }
  }

  if (settings) {
    if (!/include\s*\(\s*["']:app["']\s*\)|include\s+["']:app["']/.test(settings)) {
      violations.push("settings.gradle.kts must include the :app module");
    }
    if (/\bmavenLocal\s*\(|\bflatDir\b/.test(settings)) {
      violations.push("mavenLocal() and flatDir repositories are not allowed");
    }
    for (const url of collectMavenUrls(settings)) {
      if (!isAllowedMavenUrl(url)) {
        violations.push(`repository URL is not allowlisted: ${url.slice(0, 120)}`);
      }
    }
  }

  for (const [path, content] of [
    ["app/build.gradle.kts", appGradle],
    ["build.gradle.kts", rootGradle],
  ] as const) {
    if (!content) continue;
    if (/\bexec\b|\bjavaexec\b|\bcommandLine\b|\bProcessBuilder\b|Runtime\.getRuntime|System\.getenv/.test(content)) {
      violations.push(`${path} must not execute arbitrary processes or read the build environment`);
    }
    if (/["'][^"']*\+["']/.test(content)) {
      violations.push(`${path} must pin dependency versions (dynamic versions are not allowed)`);
    }
    if (/latest\.release|latest\.integration/.test(content)) {
      violations.push(`${path} must pin dependency versions`);
    }
    for (const url of collectMavenUrls(content)) {
      if (!isAllowedMavenUrl(url)) {
        violations.push(`repository URL is not allowlisted: ${url.slice(0, 120)}`);
      }
    }
  }

  const packageName =
    parseQuoted(withoutComments(manifest), "package") ??
    parseQuoted(appGradle, "applicationId") ??
    null;
  if (!packageName || !PACKAGE_PATTERN.test(packageName)) {
    return invalid("The Android project has no valid package/applicationId.", violations);
  }

  const expectedActivity = androidMainActivityPath(packageName);
  const kotlinActivity = expectedActivity.replace("/java/", "/kotlin/");
  const activityPath = byPath.has(expectedActivity)
    ? expectedActivity
    : byPath.has(kotlinActivity)
      ? kotlinActivity
      : null;
  if (!activityPath) {
    violations.push(`${expectedActivity}: Compose entry point is missing`);
  } else {
    const activity = byPath.get(activityPath) ?? "";
    if (!/\bclass\s+MainActivity\b/.test(activity)) {
      violations.push(`${activityPath} must declare class MainActivity`);
    }
    if (!/\b(?:ComponentActivity|AppCompatActivity)\b/.test(activity)) {
      violations.push(`${activityPath} must extend an Android activity`);
    }
    if (!activity.includes("setContent")) {
      violations.push(`${activityPath} must call setContent`);
    }
  }

  if (violations.length > 0) {
    return invalid("The Android project failed its source contract.", violations);
  }

  const compileSdk = parseNumber(appGradle, "compileSdk")!;
  const minSdk = parseNumber(appGradle, "minSdk")!;
  const targetSdk = parseNumber(appGradle, "targetSdk")!;
  const namespace = parseQuoted(appGradle, "namespace") ?? packageName;
  const applicationId = parseQuoted(appGradle, "applicationId") ?? packageName;

  return {
    ok: true,
    contract: {
      packageName,
      applicationId,
      namespace,
      compileSdk,
      minSdk,
      targetSdk,
      mainActivityPath: activityPath ?? expectedActivity,
    },
  };
}
