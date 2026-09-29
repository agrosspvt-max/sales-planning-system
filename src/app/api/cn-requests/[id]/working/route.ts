import { NextResponse, type NextRequest } from "next/server";
import { getCnWorkingDocument } from "@/features/cn-requests/service.server";
import { handle, requireAuth } from "@/lib/http";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const auth = await requireAuth();
    const { id } = await ctx.params;
    const document = await getCnWorkingDocument(auth, id);
    const disposition = req.nextUrl.searchParams.get("download") === "1" ? "attachment" : "inline";
    const fallbackName = document.fileName.replace(/[^\x20-\x7e]|["\\\r\n]/g, "_");
    return new NextResponse(new Uint8Array(document.buffer), {
      headers: {
        "Content-Type": document.mimeType,
        "Content-Length": String(document.buffer.length),
        "Content-Disposition": `${disposition}; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(document.fileName)}`,
        "Cache-Control": "private, no-store",
      },
    });
  });
}
