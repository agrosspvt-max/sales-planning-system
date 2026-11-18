export type MissingProductsStatus = {
  configured: boolean;
  months: { monthKey: string; observedAt: string }[];
  products: { dealerName: string; stockItemName: string; months: string[] }[];
};
