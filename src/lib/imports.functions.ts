// Server fns the UI calls for the URL importer.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveImport } from "./import-sources.server";
import { signImportToken, IMPORT_MAX_BYTES } from "./imports.server";

export const getDropboxAppKey = createServerFn({ method: "GET" }).handler(
  async () => {
    return { appKey: process.env.dropbox_key ?? null };
  },
);

export const resolveImportUrl = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        url: z.string().trim().min(1).max(2000),
        // Optional: when the URL is a one-shot direct link supplied by an
        // SDK (e.g. the Dropbox Chooser), trust the SDK's filename + size
        // and DO NOT re-probe with HEAD — that would burn the one-shot
        // token and the streaming GET would hang.
        prefetched: z
          .object({
            source: z.enum(["dropbox"]),
            filename: z.string().min(1).max(500),
            sizeBytes: z.number().int().positive(),
          })
          .optional(),
        // Optional: Zoom share passcode for password-protected recordings.
        passcode: z.string().min(1).max(200).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const resolved = data.prefetched
      ? {
          source: data.prefetched.source,
          directUrl: data.url,
          filename: data.prefetched.filename,
          sizeBytes: data.prefetched.sizeBytes,
          fetchHeaders: undefined as Record<string, string> | undefined,
          suggestedTitle: undefined as string | undefined,
        }
      : await resolveImport(data.url, { passcode: data.passcode });

    if (resolved.sizeBytes !== null && resolved.sizeBytes > IMPORT_MAX_BYTES) {
      const gb = (IMPORT_MAX_BYTES / (1024 ** 3)).toFixed(0);
      throw new Error(
        `That file is ${(resolved.sizeBytes / (1024 ** 3)).toFixed(2)} GB. Imports are capped at ${gb} GB.`,
      );
    }

    const token = signImportToken({
      source: resolved.source,
      directUrl: resolved.directUrl,
      filename: resolved.filename,
      sizeBytes: resolved.sizeBytes,
      sourceUrl: data.url,
      fetchHeaders: resolved.fetchHeaders,
      exp: Date.now() + 15 * 60_000,
    });

    return {
      source: resolved.source,
      filename: resolved.filename,
      sizeBytes: resolved.sizeBytes,
      suggestedTitle: resolved.suggestedTitle ?? null,
      token,
    };
  });

export const getImportStatus = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { data: row, error } = await supabaseAdmin
      .from("imports")
      .select(
        "id, status, bytes_total, bytes_uploaded, cid, filename, source, error_message",
      )
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Import not found");
    return row;
  });