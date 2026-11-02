import { RookMark } from "./RookMark.tsx";

// Same placement as the boot shell in index.html, so mounting causes no visual shift.
export function Splash() {
  return (
    <div className="relative flex h-full items-center justify-center text-paper">
      {/* Frameless window: an invisible strip to drag it by, under the native caption buttons. */}
      <div className="app-region-drag absolute inset-x-0 top-0 h-(--title-bar-height)" />
      <h1 className="sr-only">Rook</h1>
      <RookMark className="size-16" />
    </div>
  );
}
