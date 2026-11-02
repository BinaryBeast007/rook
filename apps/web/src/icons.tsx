import type { SVGProps } from "react";

// Outline icons licensed from Magnific (premium Flaticon catalog): "Sidebar" by
// Azland Studio, "Settings" by Narasena studio, "Pie chart" by Fajrul Fitrianto.
// Fills are `currentColor` so they follow the text color.
// The stroke icons further down are drawn in-house.

type IconProps = SVGProps<SVGSVGElement>;

const strokeProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export function SearchIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <circle cx="11" cy="11" r="6.25" />
      <path d="m15.75 15.75 4.5 4.5" />
    </svg>
  );
}

export function NewChatIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M11 4.75H8c-2.25 0-3.25 1-3.25 3.25v8c0 2.25 1 3.25 3.25 3.25h8c2.25 0 3.25-1 3.25-3.25v-3" />
      <path d="m17.25 3.75 3 3-7.5 7.5h-3v-3z" />
    </svg>
  );
}

const FOLDER_PATH =
  "M3.75 7.5c0-1.5.75-2.25 2.25-2.25h3.5l2 2.25H18c1.5 0 2.25.75 2.25 2.25v6.75c0 1.5-.75 2.25-2.25 2.25H6c-1.5 0-2.25-.75-2.25-2.25z";

export function FolderIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d={FOLDER_PATH} />
    </svg>
  );
}

export function FolderPlusIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d={FOLDER_PATH} />
      <path d="M12 10.25v5m-2.5-2.5h5" />
    </svg>
  );
}

export function SidebarIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="m15 1.25h-6c-.3 0-.594.01-.879.024a.81.81 0 0 0 -.121-.024.732.732 0 0 0 -.261.053c-4.526.352-6.489 2.708-6.489 7.697v6c0 4.989 1.963 7.345 6.489 7.7a.732.732 0 0 0 .261.05.81.81 0 0 0 .121-.024c.285.014.575.024.879.024h6c5.432 0 7.75-2.317 7.75-7.75v-6c0-5.433-2.318-7.75-7.75-7.75zm-7.75 19.9c-3.282-.414-4.5-2.175-4.5-6.148v-6.002c0-3.973 1.218-5.734 4.5-6.148zm14-6.15c0 4.614-1.636 6.25-6.25 6.25h-6c-.087 0-.165 0-.25-.006v-18.488c.085 0 .163-.006.25-.006h6c4.614 0 6.25 1.636 6.25 6.25zm-5.72-5.029-2.03 2.029 2.029 2.029a.75.75 0 1 1 -1.06 1.061l-2.56-2.56a.749.749 0 0 1 0-1.06l2.56-2.56a.75.75 0 0 1 1.06 1.061z" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 64 64" fill="currentColor" aria-hidden="true" {...props}>
      <path d="m40 3h-16c-11.6 0-21 9.4-21 21v16c0 11.6 9.4 21 21 21h16c11.6 0 21-9.4 21-21v-16c0-11.6-9.4-21-21-21zm19 37c0 10.5-8.5 19-19 19h-16c-10.5 0-19-8.5-19-19v-16c0-10.5 8.5-19 19-19h16c10.5 0 19 8.5 19 19z" />
      <path d="m50 27h-1.8c-.3-1-.7-2-1.2-2.9l1.2-1.2c1.2-1.2 1.2-3.1 0-4.2l-2.8-2.8c-1.1-1.1-3.1-1.1-4.2 0l-1.3 1.1c-.9-.5-1.9-.9-2.9-1.2v-1.8c0-1.7-1.3-3-3-3h-4c-1.7 0-3 1.3-3 3v1.8c-1 .3-2 .7-2.9 1.2l-1.2-1.2c-1.1-1.1-3.1-1.1-4.2 0l-2.8 2.8c-1.2 1.2-1.2 3.1 0 4.2l1.2 1.2c-.6 1-1 2-1.3 3h-1.8c-1.7 0-3 1.3-3 3v4c0 1.7 1.3 3 3 3h1.8c.3 1 .7 2 1.2 2.9l-1.2 1.2c-1.2 1.2-1.2 3.1 0 4.2l2.8 2.8c1.1 1.1 3.1 1.1 4.2 0l1.2-1.2c.9.5 1.9.9 2.9 1.2v1.9c0 1.7 1.3 3 3 3h4c1.7 0 3-1.3 3-3v-1.8c1-.3 2-.7 2.9-1.2l1.2 1.2c1.1 1.1 3.1 1.1 4.2 0l2.8-2.8c1.2-1.2 1.2-3.1 0-4.2l-1-1.3c.5-.9.9-1.9 1.2-2.9h1.8c1.7 0 3-1.3 3-3v-4c0-1.7-1.3-3-3-3zm1 7c0 .6-.4 1-1 1h-2.5c-.5 0-.9.3-1 .8-.4 1.4-.9 2.7-1.6 3.9-.2.4-.2.9.2 1.2l1.8 1.8c.4.4.4 1 0 1.4l-2.9 2.7c-.4.4-1 .4-1.4 0l-1.8-1.8c-.3-.3-.8-.4-1.2-.2-1.2.7-2.5 1.2-3.9 1.6-.4.1-.8.5-.8 1v2.6c0 .6-.4 1-1 1h-4c-.6 0-1-.4-1-1v-2.5c0-.5-.3-.9-.8-1-1.4-.4-2.7-.9-3.9-1.6-.2-.1-.3-.1-.5-.1-.3 0-.5.1-.7.3l-1.8 1.8c-.4.4-1 .4-1.4 0l-2.6-2.9c-.4-.4-.4-1 0-1.4l1.8-1.8c.3-.3.4-.8.2-1.2-.7-1.2-1.2-2.5-1.6-3.9-.1-.4-.5-.8-1-.8h-2.6c-.6 0-1-.4-1-1v-4c0-.6.4-1 1-1h2.5c.5 0 .9-.3 1-.8.4-1.4.9-2.7 1.6-3.9.2-.4.2-.9-.2-1.2l-1.8-1.8c-.4-.4-.4-1 0-1.4l2.8-2.8c.4-.4 1-.4 1.4 0l1.8 1.8c.3.3.8.4 1.2.2 1.2-.7 2.5-1.2 3.9-1.6.4-.1.8-.5.8-1v-2.4c0-.6.4-1 1-1h4c.6 0 1 .4 1 1v2.5c0 .5.3.9.8 1 1.4.4 2.7.9 3.9 1.6.4.2.9.2 1.2-.2l1.8-1.8c.4-.4 1-.4 1.4 0l2.8 2.8c.4.4.4 1 0 1.4l-1.8 1.8c-.3.3-.4.8-.2 1.2.7 1.2 1.2 2.5 1.6 3.9.1.4.5.8 1 .8h2.5c.6 0 1 .4 1 1z" />
      <path d="m32 23c-5 0-9 4-9 9s4 9 9 9 9-4 9-9-4-9-9-9zm0 16c-3.9 0-7-3.1-7-7s3.1-7 7-7 7 3.1 7 7-3.1 7-7 7z" />
    </svg>
  );
}

export function UsageIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="m12 19.792c-4.296 0-7.792-3.495-7.792-7.792 0-4.296 3.496-7.792 7.792-7.792s7.792 3.496 7.792 7.792c0 4.297-3.496 7.792-7.792 7.792zm0-14.667a6.882 6.882 0 0 0 -6.875 6.875 6.882 6.882 0 0 0 6.875 6.875 6.883 6.883 0 0 0 6.875-6.875 6.883 6.883 0 0 0 -6.875-6.875z" />
      <path d="m16.86 17.51-5.184-5.186a.458.458 0 0 1 -.134-.324v-7.333a.458.458 0 1 1 .916 0v7.143l5.05 5.051a.458.458 0 1 1 -.647.648z" />
      <path d="m19.333 12.458h-7.333a.458.458 0 1 1 0-.916h7.333a.458.458 0 1 1 0 .916z" />
      <path
        clipRule="evenodd"
        fillRule="evenodd"
        d="m17.133 1.917h-10.266c-1.042 0-1.769 0-2.334.047-.555.045-.873.13-1.115.252a2.75 2.75 0 0 0 -1.202 1.202c-.123.242-.207.56-.252 1.115-.047.565-.047 1.292-.047 2.334v10.266c0 1.042 0 1.768.047 2.334.045.555.13.873.252 1.115a2.75 2.75 0 0 0 1.202 1.202c.242.123.56.207 1.115.252.565.047 1.292.047 2.334.047h10.266c1.042 0 1.768 0 2.334-.047.555-.045.873-.13 1.115-.252a2.75 2.75 0 0 0 1.202-1.202c.123-.242.207-.56.252-1.115.047-.566.047-1.292.047-2.334v-10.266c0-1.042 0-1.769-.047-2.334-.045-.555-.13-.873-.252-1.115a2.75 2.75 0 0 0 -1.202-1.202c-.242-.123-.56-.207-1.115-.252-.566-.047-1.292-.047-2.334-.047zm-15.733 1.085c-.4.784-.4 1.811-.4 3.865v10.266c0 2.054 0 3.08.4 3.865.351.69.912 1.25 1.602 1.602.784.4 1.811.4 3.865.4h10.266c2.054 0 3.08 0 3.865-.4a3.668 3.668 0 0 0 1.602-1.602c.4-.784.4-1.811.4-3.865v-10.266c0-2.054 0-3.08-.4-3.865a3.667 3.667 0 0 0 -1.602-1.602c-.784-.4-1.811-.4-3.865-.4h-10.266c-2.054 0-3.08 0-3.865.4-.69.351-1.25.912-1.602 1.602z"
      />
    </svg>
  );
}

export function AgentsIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <rect x="4.75" y="7.75" width="14.5" height="11.5" rx="3" />
      <path d="M12 4.75v3M9.5 12.75v1.5M14.5 12.75v1.5" />
      <path d="M2.75 12.5v2.5M21.25 12.5v2.5" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="m5.75 12.5 4 4 8.5-9" />
    </svg>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="m6.75 6.75 10.5 10.5m0-10.5-10.5 10.5" />
    </svg>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M19.25 12a7.25 7.25 0 1 1-2.12-5.13" />
      <path d="M19.25 4.75v3.5h-3.5" />
    </svg>
  );
}

export function ExternalIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M8.75 15.25 16.5 7.5M10.25 7.25h6.5v6.5" />
    </svg>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M12 18.25V5.75m-5.5 5.5L12 5.75l5.5 5.5" />
    </svg>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <rect x="7.25" y="7.25" width="9.5" height="9.5" rx="2" fill="currentColor" />
    </svg>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <rect x="8.75" y="8.75" width="10.5" height="10.5" rx="2.25" />
      <path d="M15.25 8.75v-1.5c0-1.5-.75-2.5-2.5-2.5h-5.5c-1.75 0-2.5 1-2.5 2.5v5.5c0 1.5 1 2.5 2.5 2.5h1.5" />
    </svg>
  );
}

export function PencilIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="m14.75 6.25 3 3M5.75 18.25l.75-3.75 9.75-9.75a2.12 2.12 0 0 1 3 3L9.5 17.5z" />
    </svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M4.75 7.25h14.5M9.75 7.25v-1c0-1 .5-1.5 1.5-1.5h1.5c1 0 1.5.5 1.5 1.5v1" />
      <path d="m6.75 7.25.75 10.5c.1 1 .75 1.5 1.75 1.5h5.5c1 0 1.65-.5 1.75-1.5l.75-10.5" />
    </svg>
  );
}

export function BranchIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <circle cx="7.5" cy="6" r="1.75" />
      <circle cx="7.5" cy="18" r="1.75" />
      <circle cx="16.5" cy="8" r="1.75" />
      <path d="M7.5 7.75v8.5M16.5 9.75c0 3.5-3 4.25-6.5 4.75-1.25.2-2.5.75-2.5 1.75" />
    </svg>
  );
}

/** Two working copies side by side: a chat's own git worktree. */
export function WorktreeIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <rect x="4.75" y="4.75" width="9.5" height="9.5" rx="2" />
      <path d="M17.25 9.75h.5c1 0 1.5.5 1.5 1.5v6.5c0 1-.5 1.5-1.5 1.5h-6.5c-1 0-1.5-.5-1.5-1.5v-.5" />
    </svg>
  );
}

export function PaperclipIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="m18.5 11.25-6.4 6.4a4.24 4.24 0 0 1-6-6l6.75-6.75a2.83 2.83 0 0 1 4 4l-6.6 6.6a1.41 1.41 0 0 1-2-2l6-6" />
    </svg>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M13.25 4.75h-5c-1.5 0-2.5 1-2.5 2.5v9.5c0 1.5 1 2.5 2.5 2.5h7.5c1.5 0 2.5-1 2.5-2.5v-7.25z" />
      <path d="M13.25 4.75v3.5c0 1 .5 1.5 1.5 1.5h3.5" />
    </svg>
  );
}

export function TerminalIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <rect x="3.75" y="5.25" width="16.5" height="13.5" rx="2.5" />
      <path d="m7.75 10 2.25 2-2.25 2M12.25 14.5h4" />
    </svg>
  );
}

export function GlobeIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <circle cx="12" cy="12" r="7.25" />
      <path d="M4.75 12h14.5M12 4.75c-3.5 4.5-3.5 10 0 14.5M12 4.75c3.5 4.5 3.5 10 0 14.5" />
    </svg>
  );
}

export function PlugIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M9.25 4.75v3.5M14.75 4.75v3.5M7.25 8.25h9.5v3a4.75 4.75 0 0 1-9.5 0zM12 16v3.25" />
    </svg>
  );
}

export function ToolIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M14.5 5.25a4 4 0 0 0-4.75 5.25l-5 5a1.77 1.77 0 0 0 2.5 2.5l5-5a4 4 0 0 0 5.25-4.75l-2.5 2.5-2.25-.5-.5-2.25z" />
    </svg>
  );
}

export function ThinkingIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M12 4.75v1.5M12 17.75v1.5M4.75 12h1.5M17.75 12h1.5M6.9 6.9l1.05 1.05M16.05 16.05l1.05 1.05M6.9 17.1l1.05-1.05M16.05 7.95l1.05-1.05" />
      <circle cx="12" cy="12" r="2.75" />
    </svg>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M12 4.25 5.75 6.5v5c0 3.75 2.5 6.5 6.25 8.25 3.75-1.75 6.25-4.5 6.25-8.25v-5z" />
      <path d="M12 9v3.5M12 15.25v.25" />
    </svg>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <circle cx="12" cy="12" r="7.25" />
      <path d="M12 8.25v4.5M12 15.75v.25" />
    </svg>
  );
}

/** A ring with one bright arc; spin it with `motion-safe:animate-spin`. */
export function SpinnerIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <circle cx="12" cy="12" r="7" opacity="0.25" />
      <path d="M19 12a7 7 0 0 0-7-7" />
    </svg>
  );
}

/** A dial with its needle: reasoning effort. */
export function GaugeIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M4.75 16.5a7.25 7.25 0 0 1 14.5 0" />
      <path d="m12 16.5 3.25-4.25" />
    </svg>
  );
}

/** Plus over minus: a diff, i.e. the working tree's changes. */
export function DiffIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M12 4.75v8M8 8.75h8M7.25 18.25h9.5" />
    </svg>
  );
}

/** Points right; rotate it for the other way. */
export function ChevronsIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="m6.5 6.5 5.5 5.5-5.5 5.5M12.5 6.5 18 12l-5.5 5.5" />
    </svg>
  );
}

/** A box split down the middle: panes side by side; rotate it for stacked panes. */
export function SplitIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <rect x="4.75" y="4.75" width="14.5" height="14.5" rx="2.5" />
      <path d="M12 4.75v14.5" />
    </svg>
  );
}

/** FileIcon with a plus: a new file. */
export function FilePlusIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M13.25 4.75h-5c-1.5 0-2.5 1-2.5 2.5v9.5c0 1.5 1 2.5 2.5 2.5h7.5c1.5 0 2.5-1 2.5-2.5v-7.25z" />
      <path d="M13.25 4.75v3.5c0 1 .5 1.5 1.5 1.5h3.5M12 12.25v4.5m-2.25-2.25h4.5" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M12 6.25v11.5M6.25 12h11.5" />
    </svg>
  );
}

export function MoreIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <circle cx="12" cy="6.5" r="1" fill="currentColor" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <circle cx="12" cy="17.5" r="1" fill="currentColor" />
    </svg>
  );
}

export function CodeIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.25 6.5l-2.5 11" />
    </svg>
  );
}

export function CommitIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <circle cx="12" cy="12" r="3.25" />
      <path d="M3.75 12h5M15.25 12h5" />
    </svg>
  );
}

export function PushIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M12 15.25v-10M8 9.25l4-4 4 4M5.25 18.75h13.5" />
    </svg>
  );
}

export function PullIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M12 5.25v10M8 11.25l4 4 4-4M5.25 18.75h13.5" />
    </svg>
  );
}

export function PullRequestIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <circle cx="6.75" cy="6" r="2" />
      <circle cx="6.75" cy="18" r="2" />
      <circle cx="17.25" cy="18" r="2" />
      <path d="M6.75 8v8M17.25 16v-6.25a2.5 2.5 0 0 0-2.5-2.5H11.5M13.5 5.25l-2 2 2 2" />
    </svg>
  );
}

export function SlidersIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M4.75 7.5h8.5M17.25 7.5h2M4.75 16.5h2M10.75 16.5h8.5" />
      <circle cx="15.25" cy="7.5" r="2" />
      <circle cx="8.75" cy="16.5" r="2" />
    </svg>
  );
}

export function ContrastIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 3.75a8.25 8.25 0 0 1 0 16.5z" fill="currentColor" />
    </svg>
  );
}

// Provider logos: the vendors' official marks, as published in LobeHub's icon set (MIT).
// Claude keeps its brand color in every theme; OpenAI's mark is monochrome and follows the text.
export function ClaudeLogo(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...props}>
      <path
        fill="var(--color-brand-claude)"
        d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"
      />
    </svg>
  );
}

export function OpenAILogo(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"
      />
    </svg>
  );
}

/** A page with lines of text: Markdown and prose files. */
export function FileTextIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M13.25 4.75h-5c-1.5 0-2.5 1-2.5 2.5v9.5c0 1.5 1 2.5 2.5 2.5h7.5c1.5 0 2.5-1 2.5-2.5v-7.25z" />
      <path d="M13.25 4.75v3.5c0 1 .5 1.5 1.5 1.5h3.5M9 13h6M9 16h4" />
    </svg>
  );
}

/** Curly braces: JSON and config files. */
export function BracesIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <path d="M9 4.75H8.25c-1.1 0-2 .9-2 2v2.5c0 1.1-.9 2-2 2v1.5c1.1 0 2 .9 2 2v2.5c0 1.1.9 2 2 2H9M15 4.75h.75c1.1 0 2 .9 2 2v2.5c0 1.1.9 2 2 2v1.5c-1.1 0-2 .9-2 2v2.5c0 1.1-.9 2-2 2H15" />
    </svg>
  );
}

/** A framed landscape: image files. */
export function ImageIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <rect x="4.75" y="4.75" width="14.5" height="14.5" rx="2.5" />
      <circle cx="9.5" cy="9.5" r="1.5" />
      <path d="m19.25 15-4-4-8.5 8.25" />
    </svg>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <svg {...strokeProps} {...props}>
      <circle cx="12" cy="12" r="7.25" />
      <path d="M12 11.25v4.5M12 8v.25" />
    </svg>
  );
}
