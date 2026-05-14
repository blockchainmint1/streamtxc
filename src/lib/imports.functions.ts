// Server fns the UI calls for the URL importer.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { resolveImport } from "./import-sources.server";
import { signImportToken, IMPORT_MAX_BYTES } from "./imports.server";

export const resolveImportUrl = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ url: z.string().trim().min(1).max(2000) }).parse(input),
  )
  .handler(async ({ data }) => {
    const resolved = await resolveImport(data.url);

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
      exp: Date.now() + 15 * 60_000,
    });

    return {
      source: resolved.source,
      filename: resolved.filename,
      sizeBytes: resolved.sizeBytes,
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