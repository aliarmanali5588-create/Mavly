export type AttachmentKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "sheet"
  | "doc"
  | "slides"
  | "text"
  | "code"
  | "data"
  | "archive"
  | "model3d"
  | "font"
  | "design"
  | "file";

export function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i] || "B"}`;
}

export function truncateFileName(name: string, maxLength = 24): string {
  if (!name || name.length <= maxLength) return name;
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex === -1 || dotIndex === 0 || name.length - dotIndex > 8) {
    return `${name.slice(0, maxLength - 3)}...`;
  }
  const ext = name.slice(dotIndex);
  const baseName = name.slice(0, dotIndex);
  const keepLength = maxLength - ext.length - 3;
  if (keepLength <= 0) return `${name.slice(0, maxLength - 3)}...`;
  return `${baseName.slice(0, keepLength)}...${ext}`;
}

export function isPreviewableImage(file: { name: string; type?: string }): boolean {
  if (!file) return false;
  const type = file.type || "";
  const name = file.name || "";
  const ext = (name.split(".").pop() || "").toLowerCase();

  if (type.startsWith("image/")) {
    return !type.includes("svg");
  }
  return ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"].includes(ext);
}

export function attachmentKind(name: string, type?: string): AttachmentKind {
  const mime = (type || "").toLowerCase();
  const ext = (name.split(".").pop() || "").toLowerCase();

  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico"].includes(ext)) {
    return "image";
  }
  if (mime.startsWith("video/") || ["mp4", "webm", "mov", "avi", "mkv"].includes(ext)) {
    return "video";
  }
  if (mime.startsWith("audio/") || ["mp3", "wav", "ogg", "aac", "flac", "m4a"].includes(ext)) {
    return "audio";
  }
  if (mime === "application/pdf" || ext === "pdf") {
    return "pdf";
  }
  if (
    mime.includes("spreadsheet") ||
    mime.includes("excel") ||
    mime.includes("csv") ||
    ["csv", "xls", "xlsx", "ods"].includes(ext)
  ) {
    return "sheet";
  }
  if (
    mime.includes("word") ||
    mime.includes("document") ||
    ["doc", "docx", "odt", "rtf"].includes(ext)
  ) {
    return "doc";
  }
  if (
    mime.includes("presentation") ||
    mime.includes("powerpoint") ||
    ["ppt", "pptx", "key"].includes(ext)
  ) {
    return "slides";
  }
  if (
    ["zip", "tar", "gz", "7z", "rar", "bz2"].includes(ext) ||
    mime.includes("zip") ||
    mime.includes("compressed") ||
    mime.includes("archive")
  ) {
    return "archive";
  }
  if (["json", "xml", "yaml", "yml", "sql"].includes(ext) || mime.includes("json")) {
    return "data";
  }
  if (
    ["js", "ts", "jsx", "tsx", "py", "java", "c", "cpp", "h", "cs", "go", "rs", "rb", "php", "html", "css", "scss", "sh"].includes(ext)
  ) {
    return "code";
  }
  if (["txt", "md", "log"].includes(ext) || mime.startsWith("text/")) {
    return "text";
  }
  if (["gltf", "glb", "obj", "stl", "fbx"].includes(ext)) {
    return "model3d";
  }
  if (["ttf", "otf", "woff", "woff2"].includes(ext)) {
    return "font";
  }
  if (["fig", "sketch", "xd", "psd", "ai"].includes(ext)) {
    return "design";
  }
  return "file";
}

export function filesFromClipboard(
  input: DataTransfer | ClipboardEvent | React.ClipboardEvent | null | undefined
): File[] {
  if (!input) return [];
  const dt =
    "clipboardData" in input && input.clipboardData
      ? input.clipboardData
      : "files" in input || "items" in input
      ? (input as DataTransfer)
      : null;

  if (!dt) return [];

  const files: File[] = [];
  if (dt.files && dt.files.length > 0) {
    for (let i = 0; i < dt.files.length; i++) {
      const file = dt.files.item(i);
      if (file) files.push(file);
    }
  } else if (dt.items && dt.items.length > 0) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (item && item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
  }
  return files;
}
