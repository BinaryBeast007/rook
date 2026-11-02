/** The first line the desktop gives command output that lost its start (desk/chat/output.ts). */
export const EARLIER_OUTPUT = "… earlier output not shown";

/** Command output without its "earlier output not shown" line; `cut` says it had one. */
export function splitEarlier(output: string): { cut: boolean; text: string } {
  return output.startsWith(`${EARLIER_OUTPUT}\n`)
    ? { cut: true, text: output.slice(EARLIER_OUTPUT.length + 1) }
    : { cut: false, text: output };
}

const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;

/**
 * Notice text with its UTC times (e.g. a usage limit's reset) in the user's local time: the time
 * alone today, with the date otherwise.
 */
export function localTimes(text: string, now = new Date()): string {
  return text.replace(ISO_TIME, (iso) => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const today = date.toDateString() === now.toDateString();
    return date.toLocaleString(undefined, {
      ...(today ? {} : { month: "short", day: "numeric" }),
      hour: "numeric",
      minute: "2-digit",
    });
  });
}
