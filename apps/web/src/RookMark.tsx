import type { SVGProps } from "react";

/** The Rook mark from assets/brand/mark.svg. Inherits `currentColor`. */
export function RookMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M10 4H22V12H28V4H36V12H42V4H54V20H10ZM18 24H46L54 60H10ZM29 34V48H35V34Z"
      />
    </svg>
  );
}
