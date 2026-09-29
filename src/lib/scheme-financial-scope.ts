/**
 * Financial/recovery reads include enrolled plans and active Admin-verified bill schedules without treating
 * partial verification as enrollment. Keep this one shared definition for Payments, Follow-up and Daily Work.
 */
export const billFinancialScope = { OR: [
  { enrollmentStatus: "ENROLLED" as const },
  { bills: { some: { verifiedAt: { not: null } } } },
  { instances: { some: { bills: { some: { verifiedAt: { not: null } } } } } }, // historical instance-owned bills
] };
