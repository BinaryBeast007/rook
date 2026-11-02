// The chat's folder for the Files tool. Paths are relative to the folder, `/`-separated, and
// `""` is the folder itself; the main process rejects any that leave it.

export const FilesChannel = {
  list: "rook:files:list",
  read: "rook:files:read",
  search: "rook:files:search",
  createFile: "rook:files:create-file",
  createFolder: "rook:files:create-folder",
  rename: "rook:files:rename",
  delete: "rook:files:delete",
} as const;

export interface DirEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink" | "other";
  /** Bytes, for files. */
  readonly size: number | null;
}

export interface DirListing {
  readonly path: string;
  /** Directories first, then by name. */
  readonly entries: readonly DirEntry[];
  /** The directory has more entries than the listing holds. */
  readonly truncated: boolean;
}

export interface FileContent {
  readonly path: string;
  readonly size: number;
  /** `text` holds the content; `binary` and `tooLarge` hold none. */
  readonly kind: "text" | "binary" | "tooLarge";
  readonly text: string | null;
}

export interface FileSearchResult {
  /** File paths, best match first. */
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

export interface FilesBridge {
  list(chatId: string, path: string): Promise<DirListing>;
  read(chatId: string, path: string): Promise<FileContent>;
  search(chatId: string, query: string): Promise<FileSearchResult>;
  /** Rejects when something already exists at `path`. */
  createFile(chatId: string, path: string): Promise<void>;
  createFolder(chatId: string, path: string): Promise<void>;
  /** Rejects when something already exists at `to`. */
  rename(chatId: string, from: string, to: string): Promise<void>;
  /** Moves the file or folder to the OS trash, so it can be restored. */
  delete(chatId: string, path: string): Promise<void>;
}
