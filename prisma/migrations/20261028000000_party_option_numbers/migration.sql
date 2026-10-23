-- A market entry may now have any number of candidate party options (at least two complete ones is enforced by the application, 10 at most).
-- The original CHECK allowed only option numbers 1 and 2; relax it. No data is touched, and uniqueness of (monthlyPlanId, optionNo) is unchanged.
ALTER TABLE "PartyMonthlyOption" DROP CONSTRAINT "PartyMonthlyOption_optionNo_check";
ALTER TABLE "PartyMonthlyOption" ADD CONSTRAINT "PartyMonthlyOption_optionNo_check" CHECK ("optionNo" BETWEEN 1 AND 10);
