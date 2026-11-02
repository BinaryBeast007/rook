import type { SVGProps } from "react";

import { BracesIcon, CodeIcon, FileIcon, FileTextIcon, ImageIcon } from "../icons.tsx";
import { fileKind } from "./fileRefs.ts";

const ICONS = {
  code: CodeIcon,
  markdown: FileTextIcon,
  config: BracesIcon,
  image: ImageIcon,
  file: FileIcon,
};

/** The icon for a file's type, picked by its extension. */
export function FileTypeIcon({ path, ...props }: { path: string } & SVGProps<SVGSVGElement>) {
  const Icon = ICONS[fileKind(path)];
  return <Icon {...props} />;
}
