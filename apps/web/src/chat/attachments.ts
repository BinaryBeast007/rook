// Which files a prompt may carry. The main process enforces the same limits.
import { ATTACHMENT_LIMITS } from "@rook/contracts";

const TEXT_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/sql",
  "application/graphql",
]);

const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    "txt md mdx markdown json jsonc json5 yaml yml toml ini cfg conf env xml csv tsv log " +
    "js mjs cjs jsx ts mts cts tsx vue svelte astro css scss sass less html htm " +
    "py rb php java kt kts scala go rs swift c h cc cpp cxx hpp m mm cs fs vb lua pl r dart " +
    "ex exs erl hs clj elm zig nim sh bash zsh fish ps1 bat cmd sql graphql gql proto " +
    "dockerfile makefile gradle tf hcl lock gitignore editorconfig prisma"
  ).split(" "),
);

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

function extension(name: string): string {
  const base = name.toLowerCase().split(/[\\/]/).at(-1) ?? "";
  const dot = base.lastIndexOf(".");
  return dot === -1 ? base : base.slice(dot + 1);
}

export type AttachmentCheck =
  | { readonly ok: true; readonly kind: "image" | "text"; readonly mediaType: string }
  | { readonly ok: false; readonly error: string };

/** Whether a file can go with a prompt, and as what. `images`: the model reads images. */
export function checkAttachment(
  file: { readonly name: string; readonly type: string; readonly size: number },
  images: boolean,
): AttachmentCheck {
  const { name, type, size } = file;
  const imageTypes: readonly string[] = ATTACHMENT_LIMITS.imageTypes;
  if (imageTypes.includes(type)) {
    if (!images)
      return { ok: false, error: `This model can't read images, so ${name} wasn't added.` };
    if (size > ATTACHMENT_LIMITS.imageBytes)
      return {
        ok: false,
        error: `${name} is larger than ${formatBytes(ATTACHMENT_LIMITS.imageBytes)}.`,
      };
    return { ok: true, kind: "image", mediaType: type };
  }
  const text =
    type.startsWith("text/") || TEXT_TYPES.has(type) || TEXT_EXTENSIONS.has(extension(name));
  if (!text) {
    const image = type.startsWith("image/");
    return {
      ok: false,
      error: image
        ? `${name} isn't a supported image. Use PNG, JPEG, GIF or WebP.`
        : `${name} isn't an image or a text file.`,
    };
  }
  if (size > ATTACHMENT_LIMITS.textBytes)
    return {
      ok: false,
      error: `${name} is larger than ${formatBytes(ATTACHMENT_LIMITS.textBytes)}.`,
    };
  const mediaType = type.startsWith("text/") || TEXT_TYPES.has(type) ? type : "text/plain";
  return { ok: true, kind: "text", mediaType };
}
