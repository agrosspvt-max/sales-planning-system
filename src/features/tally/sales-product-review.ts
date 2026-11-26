import { z } from "zod";
import type { ProductResolver } from "@/lib/product-resolver";
import { cleanProductName } from "@/features/sales-upload/parser";
import { tightKey } from "@/lib/match-key";

export const pendingSalesProductId = (raw: string) =>
  `tally-pending:${tightKey(cleanProductName(raw)) || encodeURIComponent(raw)}`;

/** An unattended capture may suggest a fuzzy match, but must not adopt its NBV rate. */
export function salesProductMatch(resolver: ProductResolver, raw: string) {
  const name = cleanProductName(raw);
  const product = resolver.resolveProductUnique(name, { fuzzy: false });
  const suggestion = product ? null : resolver.resolveProductUnique(name);
  return {
    product,
    productId: product?.id ?? pendingSalesProductId(raw),
    name: name || raw,
    notice: product
      ? undefined
      : suggestion
        ? `Are ${name} and ${suggestion.name} the same product? Sales included; NBV pending. Confirm the product mapping or create the separate product, then refresh Sales.`
        : `${name || raw}: product match needs review. Sales included; NBV pending. Create or map the product, then refresh Sales.`,
  };
}

const units = z.array(z.object({ unit: z.string(), quantity: z.string() }));
const schema = z.object({
  productReviewVersion: z.literal(1),
  pendingProducts: z.array(
    z.object({
      dealerId: z.string(),
      productId: z.string(),
      name: z.string(),
      notice: z.string(),
      quantity: z.string(),
      amount: z.string(),
      units,
    }),
  ),
  productUnits: z.array(z.object({ dealerId: z.string(), productId: z.string(), units })),
});
export type SalesProductReview = z.infer<typeof schema>;
export function salesProductReview(raw: unknown): SalesProductReview | null {
  const result = schema.safeParse(raw);
  return result.success ? result.data : null;
}
