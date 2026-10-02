import type { NextRequest } from "next/server";
import { historicalUpload } from "@/features/historical-daybook/upload-route.server";
export const maxDuration = 60;
export async function POST(req: NextRequest) {
  return historicalUpload(req, true);
}
