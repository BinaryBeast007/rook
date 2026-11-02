// The Files side tool's main-process half: browse, read, search, and change the chat's folder.
import { FilesChannel } from "@rook/contracts";
import { shell } from "electron";

import type { Handle, WorkspaceContext } from "../workspace/context.ts";
import {
  createFile,
  createFolder,
  listDirectory,
  readTextFile,
  renameEntry,
  trashEntry,
} from "./files.ts";
import { createFileSearch } from "./search.ts";

export function registerFilesHandlers(context: WorkspaceContext, handle: Handle): void {
  const search = createFileSearch(context.env);
  // So Rook's own changes show up in the next search, not only once the index expires.
  const change = async (chatId: unknown, work: (root: string) => Promise<void>) => {
    const root = context.cwd(chatId);
    try {
      await work(root);
    } finally {
      search.invalidate(root);
    }
  };

  handle(FilesChannel.list, (_event, chatId, path) => listDirectory(context.cwd(chatId), path));
  handle(FilesChannel.read, (_event, chatId, path) => readTextFile(context.cwd(chatId), path));
  handle(FilesChannel.search, (_event, chatId, query) => search.search(context.cwd(chatId), query));
  handle(FilesChannel.createFile, (_event, chatId, path) =>
    change(chatId, (root) => createFile(root, path)),
  );
  handle(FilesChannel.createFolder, (_event, chatId, path) =>
    change(chatId, (root) => createFolder(root, path)),
  );
  handle(FilesChannel.rename, (_event, chatId, from, to) =>
    change(chatId, (root) => renameEntry(root, from, to)),
  );
  handle(FilesChannel.delete, (_event, chatId, path) =>
    change(chatId, (root) => trashEntry(root, path, (abs) => shell.trashItem(abs))),
  );
}
