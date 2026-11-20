import { z } from "zod";

// Transport bounds are independent of the per-voucher/product validation limits.
export const DAYBOOK_CHUNK_BYTES = 256 * 1024;
export const DAYBOOK_CAPTURE_BYTES = 32 * 1024 * 1024;
export const daybookUploadHash = z.string().regex(/^[a-f0-9]{64}$/);
export const daybookUploadManifest = z
  .object({
    chunks: z
      .number()
      .int()
      .min(1)
      .max(DAYBOOK_CAPTURE_BYTES / DAYBOOK_CHUNK_BYTES),
    bytes: z.number().int().min(1).max(DAYBOOK_CAPTURE_BYTES),
    sha256: daybookUploadHash,
  })
  .strict()
  .refine(
    (manifest) => manifest.chunks === Math.ceil(manifest.bytes / DAYBOOK_CHUNK_BYTES),
    "Invalid Daybook batch count",
  );
export const daybookUploadChunk = {
  sequence: z.number().int().min(0),
  hash: daybookUploadHash,
  // The office outbox uses ASCII JSON escapes, so characters and bytes agree.
  data: z
    .string()
    .min(1)
    .max(DAYBOOK_CHUNK_BYTES)
    .regex(/^[\x20-\x7e]+$/),
};
