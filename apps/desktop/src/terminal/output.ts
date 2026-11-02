// A session's output: what arrived since the last flush (sent as one batched event) and a capped
// history of what was flushed (replayed when a view attaches). Pure, so it's tested on its own.

export interface Flushed {
  readonly data: string;
  /** Total output length once `data` is appended; views use it to skip what they replayed. */
  readonly seq: number;
}

export class TerminalOutput {
  #pending = "";
  #chunks: string[] = [];
  #kept = 0;
  #seq = 0;
  readonly #cap: number;

  /** `cap` is the history kept for replay, in UTF-16 units. */
  constructor(cap: number) {
    this.#cap = cap;
  }

  push(data: string): void {
    this.#pending += data;
  }

  get pending(): number {
    return this.#pending.length;
  }

  /** Moves pending output into the history. Null when nothing arrived since the last flush. */
  flush(): Flushed | null {
    if (!this.#pending) return null;
    const data = this.#pending;
    this.#pending = "";
    this.#seq += data.length;
    this.#chunks.push(data);
    this.#kept += data.length;
    // Drop whole chunks while that stays at or above the cap, then trim the oldest one.
    while (this.#chunks.length > 1 && this.#kept - this.#chunks[0]!.length >= this.#cap) {
      this.#kept -= this.#chunks.shift()!.length;
    }
    if (this.#kept > this.#cap) {
      this.#chunks[0] = this.#chunks[0]!.slice(this.#kept - this.#cap);
      this.#kept = this.#cap;
    }
    return { data, seq: this.#seq };
  }

  /** The kept history and the seq it ends at. Call after `flush` so nothing pending is left out. */
  snapshot(): Flushed {
    // Joining once keeps later snapshots cheap.
    if (this.#chunks.length > 1) this.#chunks = [this.#chunks.join("")];
    return { data: this.#chunks[0] ?? "", seq: this.#seq };
  }
}
