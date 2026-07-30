import { redirect } from "next/navigation";

/**
 * Deprecated. Monthly Planning is now a first-class lifecycle (one MonthlyPlan per month),
 * reached from the approved seasonal plan via the "Select Monthly Plan" dialog, or from
 * Create New Plan → Monthly. This legacy all-months route redirects to the seasonal plan.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/planning/${id}`);
}
