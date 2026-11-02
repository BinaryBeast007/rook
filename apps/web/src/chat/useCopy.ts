import { useEffect, useRef, useState } from "react";

/** Copies text to the clipboard; `copied` stays true briefly so the button can confirm it. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1500);
      })
      // A denied clipboard leaves the label unchanged, which is the honest result.
      .catch(() => undefined);
  };

  return { copied, copy };
}
