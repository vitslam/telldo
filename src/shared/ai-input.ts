/** Bytes come only from the host's owned attachment store, never renderer paths. */
export interface AIInputAttachment {
  id: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
  kind: "image" | "file";
}
export const MAX_AI_ATTACHMENTS = 12;
export const MAX_AI_IMAGE_COUNT = 8;
export const MAX_AI_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_AI_INPUT_BYTES = 50 * 1024 * 1024;
