// Native notifications for chats that finish or need approval while Rook is in the background.

export const NotificationChannel = {
  show: "rook:notifications:show",
  /** Main → renderer push of the chat id of a notification the user clicked. */
  clicked: "rook:notifications:clicked",
} as const;

export interface ChatNotification {
  readonly chatId: string;
  /** Up to 200 characters, e.g. the chat's title. */
  readonly title: string;
  /** Up to 500 characters. */
  readonly body: string;
}

export interface NotificationsBridge {
  /** Shows a native notification, unless a Rook window has focus. Never rejects. */
  show(notification: ChatNotification): Promise<void>;
  /**
   * Calls `listener` with the chat id when a notification is clicked; Rook is focused by then.
   * Returns an unsubscribe function.
   */
  subscribe(listener: (chatId: string) => void): () => void;
}
